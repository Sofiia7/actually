import React, { useEffect, useState } from 'react'
import { GlassSurface } from './components/GlassSurface'
import { Header } from './components/Header'
import { Tabs, type TabName } from './components/Tabs'
import { CheckTab, type CheckState, type Market as DesignMarket } from './tabs/CheckTab'
import { HistoryTab, type HistoryState, type HistoryRow, type TradeRow } from './tabs/HistoryTab'
import { SettingsTab, type SettingsValues } from './tabs/SettingsTab'
import { TradeTabWired } from './TradeTabWired'

import type {
  HistoryItem,
  Settings as SettingsT,
  TestKeysResult,
  TradeLogItem,
} from '../shared/types'
import {
  BUILDER_CODE,
  DEFAULT_WORKER_URL,
  DEFAULT_WORKER_SECRET,
} from '../shared/constants'
import { COLOR_THRESHOLDS, defaultThresholds, priceFromOutcomes, type MatchResult } from '@actually/core'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'
import { extractActiveTabArticle } from '../popup/operations'
import { getCacheStatus } from '../background/cache'
import { trackEvent } from '../background/telemetry'
import { buildMarketUrl, marketPageUrl, polymarketSearchUrl } from '../background/polymarket'
import { clearTradeLog, getTradeLog } from '../background/tradeLog'
import { findOutcomeIndex, formatRelative } from '@actually/core'
import {
  disconnectWalletViaOffscreen,
  refreshCacheViaOffscreen,
  resolveHistoryMarketViaOffscreen,
  restoreWalletViaOffscreen,
  runMatchViaOffscreen,
} from './ops'
import type { SerializableWalletState } from '../shared/messages'
import type { ArticleData } from '../shared/types'
import {
  browserDetector,
  browserTranslator,
  languageName,
  translateArticle,
  translationNotice,
  type TranslationNotice,
} from './translate'

// =============================================================
// Provider / language ↔ design-string mapping
// =============================================================
const PROVIDER_LABELS: Record<SettingsT['embeddingProvider'], string> = {
  local: 'Local (free, runs on your device)',
  openai: 'OpenAI · text-embedding-3-small',
}
const LABEL_TO_PROVIDER: Record<string, SettingsT['embeddingProvider']> = {
  'Local (free, runs on your device)': 'local',
  'OpenAI · text-embedding-3-small': 'openai',
}
// =============================================================
// MatchResult → design Market
// =============================================================
function toDesignMarket(m: MatchResult): DesignMarket {
  const d = m.market.description?.trim()
  return {
    q: m.market.question,
    pct: Math.round((m.freshPrice ?? m.probability) * 100),
    vol: formatVolume(m.market.volume),
    match: Math.round(m.confidence * 100),
    market: 'Polymarket',
    desc: d ? (d.length > 200 ? d.slice(0, 200).replace(/\s+\S*$/, '') + '…' : d) : undefined,
  }
}
function altToDesignMarket(question: string, score: number | undefined): DesignMarket {
  return { q: question, pct: score != null ? Math.round(score * 100) : 0 }
}
function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`
  return `$${Math.round(v)}`
}
/** Cut at a word boundary - a market question mid-word reads as corruption. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, '') + '…'
}
/** One activity-log entry → the History tab's row shape. The detail line is
 * built here (not in the tab) so the tab stays a dumb renderer. */
function tradeToRow(t: TradeLogItem): TradeRow {
  const cents = (p?: number) => (p == null ? null : `${(p * 100).toFixed(1)}¢`)
  const bits: string[] = []
  if (t.kind === 'REDEEM') {
    if (t.shares != null) bits.push(`${t.shares} shares`)
    if (t.outcome) bits.push(t.outcome)
  } else {
    if (t.usd != null) bits.push(`$${t.usd.toFixed(2)}`)
    if (t.shares != null) bits.push(`${t.shares.toFixed(2)} shares`)
    const at = cents(t.price)
    bits.push(`${t.outcome ?? '-'}${at ? ` @ ${at}` : ''}`)
    if (t.orderType) bits.push(t.orderType.toLowerCase())
  }
  return {
    kind: t.kind,
    status: t.status,
    q: t.question,
    detail: bits.join(' · '),
    when: formatRelative(t.timestamp),
    error: t.error,
    onOpen: t.marketSlug
      ? () => window.open(buildMarketUrl(t.marketSlug!), '_blank', 'noopener,noreferrer')
      : undefined,
  }
}

function historyToRow(h: HistoryItem): HistoryRow {
  return {
    pct: Math.round(h.probability * 100),
    q: h.question,
    src: h.pageDomain || '-',
    when: formatRelative(h.timestamp),
  }
}

/**
 * Promote an alternate match to the featured slot when the user picks it in
 * CheckTab. Recomputes the YES probability/color from the picked market's own
 * outcome prices and demotes the previously-featured market into the alternates
 * list so the user can switch back.
 */
function buildMatchFromAlternative(prev: MatchResult, index: number): MatchResult | null {
  const picked = prev.alternatives[index]
  if (!picked) return null
  const rest = prev.alternatives.filter((_, i) => i !== index)
  const restScores = (prev.alternativeScores ?? []).filter((_, i) => i !== index)
  const yesIdx = findOutcomeIndex(picked.outcomes, 'Yes')
  let probability = 0
  try {
    const prices = JSON.parse(picked.outcomePrices) as string[]
    probability = parseFloat(prices[yesIdx] ?? '0') || 0
  } catch {
    probability = 0
  }
  const color: MatchResult['color'] =
    probability < COLOR_THRESHOLDS.blue ? 'blue' : probability < COLOR_THRESHOLDS.yellow ? 'yellow' : 'red'
  return {
    market: picked,
    probability,
    confidence: prev.alternativeScores?.[index] ?? prev.confidence,
    color,
    lowConfidence: prev.lowConfidence,
    alternatives: [prev.market, ...rest],
    alternativeScores: [prev.confidence, ...restScores],
  }
}

// =============================================================
export interface IntegratedPopupProps {
  /**
   * Strategy for pulling headline+body off the current page. Two
   * contexts differ:
   *   - popup: cannot read the page directly, must use
   *     chrome.scripting.executeScript against the active tab.
   *   - widget (content-script): already IS the page, can call
   *     extractFromPage() inline.
   * Default = extractActiveTabArticle (popup-style).
   */
  extractor?: () => Promise<ArticleData | null>
  /** Optional close hook (widget shows an X; popup hides it). */
  onClose?: () => void
}

export const IntegratedPopup: React.FC<IntegratedPopupProps> = ({
  extractor = extractActiveTabArticle,
  onClose,
}) => {
  const [tab, setTab] = useState<TabName>('Check')
  const [settings, setSettings] = useState<SettingsT | null>(null)

  // Check tab state
  const [checkState, setCheckState] = useState<CheckState>({ kind: 'idle' })
  const [lastMatch, setLastMatch] = useState<MatchResult | null>(null)
  // Headline of the page the last match was run against - surfaced as match
  // context in the Trade tab (ТЗ §6.1).
  const [lastArticleHeadline, setLastArticleHeadline] = useState<string | null>(null)
  // Distinguishes a live page-derived match (real confidence score) from a
  // market picked from History (no scoring happened - the user chose it
  // directly). MatchContext must not present the latter as if it were the
  // former (see its own doc comment).
  const [lastMatchSource, setLastMatchSource] = useState<'page' | 'history'>('page')
  // What happened to the article's language on the way into the matcher -
  // translated, or why not. Cleared at the start of every check so it can
  // never describe a page the user has already navigated away from.
  const [translationNote, setTranslationNote] = useState<TranslationNotice | null>(null)

  // History tab state
  const [historyState, setHistoryState] = useState<HistoryState>({ kind: 'loading' })
  // Raw items backing historyState, same order/index - lets onSelect/
  // onOpenArticle address the exact clicked item by index instead of
  // re-fetching history and re-matching it by (question, pageDomain), which
  // silently fails (and can pick the wrong item) whenever pageDomain is
  // empty or two entries share a question+domain.
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [historyResolveError, setHistoryResolveError] = useState<string | null>(null)
  // The user's own trades. Separate from historyItems: matches are things you
  // looked at, these are things you did - and they must survive "Clear history".
  const [tradeItems, setTradeItems] = useState<TradeLogItem[]>([])

  // Settings tab state
  const [cache, setCache] = useState<{ count: number; lastUpdated: number }>({ count: 0, lastUpdated: 0 })
  const [testStatus, setTestStatus] = useState<string>('')
  const [autoRefreshing, setAutoRefreshing] = useState(false)

  // Wallet slot in Settings (read-only display + wipe button)
  const [wallet, setWallet] = useState<SerializableWalletState | null>(null)
  const [wiping, setWiping] = useState(false)

  // Refresh wallet view when entering Settings - covers the case where the
  // user connected on the Trade tab and immediately switches over.
  useEffect(() => {
    if (tab !== 'Settings') return
    void (async () => {
      try {
        const w = await restoreWalletViaOffscreen()
        setWallet(w)
      } catch {
        setWallet(null)
      }
    })()
  }, [tab])

  async function wipeWallet() {
    if (wiping) return
    if (!confirm('Disconnect wallet and erase locally stored CLOB credentials? You will need to reconnect to trade.')) return
    setWiping(true)
    try {
      await disconnectWalletViaOffscreen()
      setWallet(null)
    } finally {
      setWiping(false)
    }
  }

  // ---- bootstrap ----
  useEffect(() => {
    void (async () => {
      const res = (await sendToBackground({ type: 'GET_SETTINGS' })) as Extract<
        ResponseMessage,
        { type: 'SETTINGS_RESPONSE' }
      >
      setSettings(res.settings)
      const status = await getCacheStatus()
      setCache({ count: status.count, lastUpdated: status.lastUpdated })
      // Load the check log up front, not just when the History tab is opened.
      // The Trade tab has to be able to tell "you have never checked anything"
      // apart from "you checked things, just not since this popup opened" -
      // claiming the former while History sits full of entries is simply false.
      const past = (await sendToBackground({ type: 'GET_HISTORY' })) as Extract<
        ResponseMessage,
        { type: 'HISTORY_RESPONSE' }
      >
      setHistoryItems(past.items)
      // Auto-populate the market cache on first open so the user never has to
      // press "Refresh" manually. Runs in the background; Check still works
      // (it refreshes inline if needed). Deduped in the offscreen.
      if (status.count === 0 && res.settings.workerUrl && res.settings.workerSecret) {
        setAutoRefreshing(true)
        try {
          await refreshCacheViaOffscreen()
        } catch {
          /* errors surface on demand via Check / Test connection */
        } finally {
          await refreshCache()
          setAutoRefreshing(false)
        }
      }
    })()
  }, [])

  // Refresh history any time we switch into the History tab
  useEffect(() => {
    if (tab !== 'History') return
    setHistoryState({ kind: 'loading' })
    void (async () => {
      const r = (await sendToBackground({ type: 'GET_HISTORY' })) as Extract<
        ResponseMessage,
        { type: 'HISTORY_RESPONSE' }
      >
      setHistoryItems(r.items)
      setHistoryState(
        r.items.length === 0
          ? { kind: 'empty' }
          : { kind: 'success', items: r.items.map(historyToRow) },
      )
      setTradeItems(await getTradeLog())
    })()
  }, [tab])

  // Poll cache while on Settings tab
  useEffect(() => {
    if (tab !== 'Settings') return
    void refreshCache()
    const id = setInterval(() => { void refreshCache() }, 3000)
    return () => clearInterval(id)
  }, [tab])

  async function refreshCache() {
    const c = await getCacheStatus()
    setCache({ count: c.count, lastUpdated: c.lastUpdated })
  }

  // ---- check actions ----
  /**
   * Accept the no-match screen's offer. The click IS the consent - the button
   * says what gets sent - so this turns the setting on and immediately re-runs
   * the check the user was already waiting on, rather than saving a
   * preference and leaving them to press Check again themselves.
   */
  async function enableSearchAndRetry() {
    await patchSettings({ searchFallbackEnabled: true })
    void startCheck()
  }

  async function dismissSearchOffer() {
    await patchSettings({ searchFallbackOfferDismissed: true })
    setCheckState((prev) => (prev.kind === 'error' ? { ...prev, offerSearch: false } : prev))
  }

  async function startCheck() {
    if (!settings) return
    if (!settings.workerUrl || !settings.workerSecret) {
      setCheckState({ kind: 'error', message: 'Worker not configured. Open Settings to set the API endpoint.' })
      return
    }
    setCheckState({ kind: 'loading' })
    setTranslationNote(null)
    try {
      const article = await extractor()
      if (!article) {
        setCheckState({ kind: 'error', message: "Couldn't read the article on this page. Try a news site." })
        return
      }
      setLastArticleHeadline(article.headline)
      setLastMatchSource('page')

      // Every market question on Polymarket is English, and so is the local
      // embedding model, so a foreign-language page has to be translated
      // before it can be matched at all - an untranslated Russian headline
      // scores below the floor against the market it is literally about.
      // Chrome's built-in translator does this locally. When it can't, the
      // check still runs on the original text and the notice says why.
      // The language pack is a one-time, tens-of-megabytes download that
      // Chrome performs with no UI of its own, so the percentage below is the
      // only sign the popup is working rather than wedged.
      let shownPercent = -1
      const translation = await translateArticle(article, {
        translator: browserTranslator(),
        detector: browserDetector(),
        onDownloadStart: (language) =>
          setCheckState({
            kind: 'loading',
            note: `downloading the ${languageName(language)} translator, one time only…`,
          }),
        onDownloadProgress: (language, fraction) => {
          const percent = Math.round(fraction * 100)
          if (percent === shownPercent) return
          shownPercent = percent
          setCheckState({
            kind: 'loading',
            note: `downloading the ${languageName(language)} translator… ${percent}%`,
          })
        },
      })
      setTranslationNote(translationNotice(translation))
      const matched = translation.kind === 'translated' ? translation.article : article

      // Name the phase the popup is actually in. Without this the spinner kept
      // whatever the translator last wrote under it - most confusingly
      // "downloading the Russian translator… 100%", left standing for the whole
      // market lookup, which reads as a download stuck at 100% rather than a
      // finished one.
      setCheckState({ kind: 'loading', note: 'looking for a market…' })

      const res = await runMatchViaOffscreen(matched)
      if (res.match) {
        setLastMatch(res.match)
        const featured = toDesignMarket(res.match)
        const related = res.match.alternatives.map((alt, i) =>
          altToDesignMarket(alt.question, res.match!.alternativeScores?.[i]),
        )
        setCheckState({ kind: 'success', featured, related })
      } else {
        setLastMatch(null)
        if (res.reason === 'no_article') {
          setCheckState({ kind: 'error', message: "Couldn't read the article on this page. Try a news site." })
        } else if (res.reason === 'no_keys') {
          setCheckState({ kind: 'error', message: 'Worker not configured. Open Settings to set the API endpoint.' })
        } else if (res.reason?.startsWith('cache_refresh_failed')) {
          // "TypeError: Failed to fetch" is what a dropped connection looks
          // like from inside fetch(). As a headline it reads like a bug in the
          // extension; the cause is almost always the network, and the fix is
          // the button right below. The raw text stays as the second line for
          // anyone who needs it.
          const raw = res.reason.replace('cache_refresh_failed:', '').trim()
          const networkish = /failed to fetch|networkerror|load failed|err_/i.test(raw)
          setCheckState({
            kind: 'error',
            message: networkish
              ? "Couldn't reach the market list."
              : `Couldn't load markets: ${raw}`,
            detail: networkish
              ? `The market data lives behind the extension's Worker and the request did not get through. Check your connection and try again. (${raw})`
              : undefined,
          })
        } else if (res.reason?.startsWith('match_error')) {
          setCheckState({ kind: 'error', message: res.reason.replace('match_error:', 'Match error: ') })
        } else if (res.reason?.startsWith('below_floor')) {
          // This used to read "No match (cache=789/embedded=789/floor=0.35)".
          // The counters told whoever wrote them whether the cache was empty,
          // and told the user nothing at all. They now go to the console (see
          // offscreen.ts) while the popup says what actually happened.
          if (!res.scored) {
            setCheckState({
              kind: 'error',
              message: 'No markets loaded yet.',
              detail: "The market list is empty, so there was nothing to compare this story against. Open Settings and refresh it.",
            })
          } else {
            const nearest = res.nearest
            setCheckState({
              kind: 'error',
              message: 'No open market lines up with this story.',
              detail: nearest
                ? `Closest of ${res.scored} open markets was “${truncate(nearest.question, 64)}”, and not close. ` +
                  'If Polymarket ran one on this exact story it has already resolved, and resolved markets are left out because they cannot be traded.'
                : `Checked ${res.scored} open markets. If Polymarket ran one on this story it has already resolved, and resolved markets are left out because they cannot be traded.`,
              // The translated headline, when there is one: Polymarket's own
              // search indexes English questions, so handing it the original
              // Russian would send the user to a guaranteed-empty page.
              searchUrl: polymarketSearchUrl(matched.headline),
              // The setting lives in Settings, which is where nobody looks.
              // Mention it at the only moment it is relevant - a check that
              // just came back empty - and only until the user answers.
              offerSearch: !settings.searchFallbackEnabled && !settings.searchFallbackOfferDismissed,
            })
          }
        } else if (res.reason) {
          // Catch-all: any other reason (offscreen exception, OS_ERROR
          // bubbled up, etc) - surface verbatim instead of hiding under
          // a misleading "no markets matched" empty state.
          setCheckState({ kind: 'error', message: `Match failed: ${res.reason}` })
        } else {
          setCheckState({ kind: 'empty' })
        }
      }
    } catch (err) {
      setCheckState({ kind: 'error', message: String(err) })
    }
  }

  // Promote an alternate market to the featured match (and into the Trade tab).
  function pickRelated(index: number) {
    if (!lastMatch) return
    const next = buildMatchFromAlternative(lastMatch, index)
    if (!next) return
    setLastMatch(next)
    setCheckState({
      kind: 'success',
      featured: toDesignMarket(next),
      related: next.alternatives.map((alt, i) => altToDesignMarket(alt.question, next.alternativeScores?.[i])),
    })
  }

  // ---- settings actions ----
  async function patchSettings(patch: Partial<SettingsT>) {
    const res = (await sendToBackground({ type: 'SAVE_SETTINGS', settings: patch })) as Extract<
      ResponseMessage,
      { type: 'SETTINGS_RESPONSE' }
    >
    setSettings(res.settings)
  }
  async function testConnection() {
    setTestStatus('testing…')
    const res = (await sendToBackground({ type: 'TEST_KEYS' })) as Extract<
      ResponseMessage,
      { type: 'TEST_KEYS_RESULT' }
    >
    setTestStatus(formatTestResult(res.result))
  }
  async function refreshCacheNow() {
    if (!settings) return
    try {
      await refreshCacheViaOffscreen()
      await refreshCache()
    } catch (err) {
      setTestStatus(`refresh failed: ${String(err)}`)
    }
  }

  // ---- render ----
  if (!settings) {
    return (
      <div style={{ width: 360, margin: 0 }}>
        <GlassSurface radius={12}>
          <Header />
          <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>loading…</div>
        </GlassSurface>
      </div>
    )
  }

  const settingsValues: SettingsValues = {
    provider: PROVIDER_LABELS[settings.embeddingProvider],
    confidence: settings.confidenceThreshold,
    floor: settings.lowConfidenceFloor,
    shareStats: settings.telemetryEnabled,
    searchFallback: settings.searchFallbackEnabled,
    cacheSize: cache.count,
    cacheAge: autoRefreshing ? 'loading markets…' : cache.lastUpdated ? formatRelative(cache.lastUpdated) : '-',
    version: chrome.runtime?.getManifest?.().version ?? '1.0.0',
    contract: BUILDER_CODE || '(not configured)',
    workerUrl: settings.workerUrl,
    workerSecret: settings.workerSecret,
    forceAdvanced: !DEFAULT_WORKER_URL || !DEFAULT_WORKER_SECRET,
  }

  return (
    <div style={{ width: 360, margin: 0, position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 5,
            width: 22,
            height: 22,
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,.4)',
            background: 'rgba(255,255,255,.16)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            color: 'rgba(18,26,48,.7)',
            fontSize: 14,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      )}
      <GlassSurface radius={12}>
        <Header />
        <Tabs value={tab} onChange={setTab} />
        <div style={{ minHeight: 360 }}>
          {tab === 'Check' && (
            <CheckTab
              state={checkState}
              notice={translationNote}
              onStart={startCheck}
              onBack={() => {
                setCheckState({ kind: 'idle' })
                setTranslationNote(null)
              }}
              onRetry={startCheck}
              onEnableSearch={() => void enableSearchAndRetry()}
              onDismissSearchOffer={() => void dismissSearchOffer()}
              onOpenMarket={() => {
                if (!lastMatch) return
                void trackEvent('match_clicked', settings, { color: lastMatch.color })
                window.open(
                  marketPageUrl(lastMatch.market),
                  '_blank',
                  'noopener,noreferrer',
                )
              }}
              onTrade={() => setTab('Trade')}
              onPickRelated={pickRelated}
            />
          )}
          {tab === 'Trade' && (
            <TradeTabWired
              match={lastMatch}
              articleHeadline={lastArticleHeadline}
              matchSource={lastMatchSource}
              settings={settings}
              hasEarlierChecks={historyItems.length > 0}
              onOpenHistory={() => setTab('History')}
              onPickMatch={() => {
                setTab('Check')
                if (checkState.kind !== 'success') void startCheck()
              }}
              onOpenSettings={() => setTab('Settings')}
              onMatchOpenedExternally={(market) => {
                void trackEvent('match_clicked', settings, { color: 'blue' })
                window.open(marketPageUrl(market), '_blank', 'noopener,noreferrer')
              }}
            />
          )}
          {tab === 'History' && (
            <>
              {historyResolveError && (
                <div style={{ padding: '8px 14px', fontSize: 12, color: 'rgba(160,40,40,.9)', textAlign: 'center' }}>
                  {historyResolveError}
                </div>
              )}
              <HistoryTab
                state={historyState}
                onSelect={(_row, index) => {
                  // Jump straight into Trade with this market - no need to
                  // revisit the original article and re-run Check. Address
                  // the item by its position in historyItems (the same array
                  // historyState.items was derived from) rather than
                  // re-fetching history and re-matching by displayed text,
                  // which silently does nothing when pageDomain is empty
                  // (unparsable page URL) and can pick the wrong entry when
                  // two items share a question + domain.
                  void (async () => {
                    setHistoryResolveError(null)
                    const item = historyItems[index]
                    if (!item) return
                    const resolved = await resolveHistoryMarketViaOffscreen(item.marketId)
                    if (!resolved.market) {
                      setHistoryResolveError(
                        resolved.error === 'closed'
                          ? 'This market has since closed or resolved - no longer tradeable.'
                          : "Couldn't find this market anymore - it may have been delisted.",
                      )
                      return
                    }
                    const market = resolved.market
                    const probability = priceFromOutcomes(market.outcomePrices, market.outcomes)
                    const color: MatchResult['color'] =
                      probability < COLOR_THRESHOLDS.blue ? 'blue' : probability < COLOR_THRESHOLDS.yellow ? 'yellow' : 'red'
                    setLastMatch({
                      market,
                      probability,
                      // No real confidence score exists for a manually-picked
                      // historical item - MatchContext must not print this as
                      // if it were a scored match (see lastMatchSource).
                      confidence: 1,
                      color,
                      lowConfidence: false,
                      alternatives: [],
                    })
                    setLastArticleHeadline(item.question)
                    setLastMatchSource('history')
                    setTab('Trade')
                  })()
                }}
                onOpenArticle={(_row, index) => {
                  const item = historyItems[index]
                  if (item?.pageUrl) window.open(item.pageUrl, '_blank', 'noopener,noreferrer')
                }}
                onClear={() => {
                  void (async () => {
                    await sendToBackground({ type: 'CLEAR_HISTORY' })
                    setHistoryState({ kind: 'empty' })
                    setHistoryResolveError(null)
                  })()
                }}
                trades={tradeItems.map(tradeToRow)}
                onClearTrades={() => {
                  // Separate confirm from "Clear history": this is the only
                  // local record that a trade happened.
                  if (!confirm('Erase the local record of your trades? Polymarket still has them; this only clears what the extension shows.')) return
                  void (async () => {
                    await clearTradeLog()
                    setTradeItems([])
                  })()
                }}
              />
            </>
          )}
          {tab === 'Settings' && (
            <SettingsTab
              values={settingsValues}
              testStatus={testStatus}
              onTestConnection={testConnection}
              onRefreshCache={refreshCacheNow}
              walletSlot={
                <WalletSlot wallet={wallet} onWipe={wipeWallet} wiping={wiping} />
              }
              onChange={(patch) => {
                const next: Partial<SettingsT> = {}
                if (patch.provider != null) {
                  const p = LABEL_TO_PROVIDER[patch.provider]
                  if (p) {
                    next.embeddingProvider = p
                    const td = defaultThresholds(p)
                    next.confidenceThreshold = td.confidenceThreshold
                    next.lowConfidenceFloor = td.lowConfidenceFloor
                  }
                }
                if (patch.confidence != null) next.confidenceThreshold = patch.confidence
                if (patch.floor != null) next.lowConfidenceFloor = patch.floor
                if (patch.shareStats != null) next.telemetryEnabled = patch.shareStats
                if (patch.searchFallback != null) next.searchFallbackEnabled = patch.searchFallback
                if (patch.workerUrl != null) next.workerUrl = patch.workerUrl
                if (patch.workerSecret != null) next.workerSecret = patch.workerSecret
                void patchSettings(next)
              }}
            />
          )}
        </div>
      </GlassSurface>
    </div>
  )
}

// =============================================================
// WalletSlot - read-only wallet info + wipe button inside Settings
// =============================================================
interface WalletSlotProps {
  wallet: SerializableWalletState | null
  wiping: boolean
  onWipe: () => void
}
const WalletSlot: React.FC<WalletSlotProps> = ({ wallet, wiping, onWipe }) => {
  const baseStyle: React.CSSProperties = {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(255,255,255,.06)',
    border: '1px solid rgba(255,255,255,.22)',
  }
  if (!wallet) {
    return (
      <div style={baseStyle}>
        <span className="label" style={{ color: 'rgba(35,45,70,.55)' }}>
          No wallet connected. Go to the Trade tab to connect.
        </span>
      </div>
    )
  }
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
  return (
    <div
      style={{
        ...baseStyle,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0, lineHeight: 1.4 }}>
        <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", fontSize: 11.5 }}>
          EOA {short(wallet.address)}
        </div>
        <div
          style={{
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            fontSize: 10.5,
            color: 'rgba(35,45,70,.55)',
          }}
        >
          Safe {short(wallet.safeAddress)}
        </div>
      </div>
      <button
        type="button"
        onClick={onWipe}
        disabled={wiping}
        style={{
          appearance: 'none',
          background: 'rgba(180,60,60,.12)',
          border: '1px solid rgba(180,60,60,.45)',
          color: 'rgba(140,40,40,.95)',
          borderRadius: 6,
          padding: '5px 10px',
          fontFamily: 'inherit',
          fontSize: 12,
          cursor: wiping ? 'wait' : 'pointer',
        }}
      >
        {wiping ? 'wiping…' : 'Disconnect & wipe'}
      </button>
    </div>
  )
}

function formatTestResult(r: TestKeysResult): string {
  const w = r.worker.ok ? 'Worker ✓' : `Worker ✗ ${r.worker.error ?? ''}`
  const o = r.openai ? (r.openai.ok ? ' · OpenAI ✓' : ` · OpenAI ✗ ${r.openai.error ?? ''}`) : ''
  return `${w}${o}`
}
