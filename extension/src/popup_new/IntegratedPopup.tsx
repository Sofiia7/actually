import React, { useEffect, useState } from 'react'
import { GlassSurface } from './components/GlassSurface'
import { Header } from './components/Header'
import { Tabs, type TabName } from './components/Tabs'
import { CheckTab, type CheckState, type Market as DesignMarket } from './tabs/CheckTab'
import { HistoryTab, type HistoryState, type HistoryRow } from './tabs/HistoryTab'
import { SettingsTab, type SettingsValues } from './tabs/SettingsTab'
import { TradeTabWired } from './TradeTabWired'

import type {
  HistoryItem,
  MatchResult,
  Settings as SettingsT,
  TestKeysResult,
} from '../shared/types'
import {
  BUILDER_CODE,
  DEFAULT_WORKER_URL,
  DEFAULT_WORKER_SECRET,
  defaultThresholds,
} from '../shared/constants'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'
import { extractActiveTabArticle } from '../popup/operations'
import { getCacheStatus } from '../background/cache'
import { trackEvent } from '../background/telemetry'
import { buildMarketUrl } from '../background/polymarket'
import { formatRelative } from '../background/util'
import {
  disconnectWalletViaOffscreen,
  refreshCacheViaOffscreen,
  restoreWalletViaOffscreen,
  runMatchViaOffscreen,
} from './ops'
import type { SerializableWalletState } from '../shared/messages'
import type { ArticleData } from '../shared/types'

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
  return {
    q: m.market.question,
    pct: Math.round((m.freshPrice ?? m.probability) * 100),
    vol: formatVolume(m.market.volume),
    match: Math.round(m.confidence * 100),
    market: 'Polymarket',
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
function historyToRow(h: HistoryItem): HistoryRow {
  return {
    pct: Math.round(h.probability * 100),
    q: h.question,
    src: h.pageDomain || '—',
    when: formatRelative(h.timestamp),
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

  // History tab state
  const [historyState, setHistoryState] = useState<HistoryState>({ kind: 'loading' })

  // Settings tab state
  const [cache, setCache] = useState<{ count: number; lastUpdated: number }>({ count: 0, lastUpdated: 0 })
  const [testStatus, setTestStatus] = useState<string>('')

  // Wallet slot in Settings (read-only display + wipe button)
  const [wallet, setWallet] = useState<SerializableWalletState | null>(null)
  const [wiping, setWiping] = useState(false)

  // Refresh wallet view when entering Settings — covers the case where the
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
      await refreshCache()
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
      setHistoryState(
        r.items.length === 0
          ? { kind: 'empty' }
          : { kind: 'success', items: r.items.map(historyToRow) },
      )
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
  async function startCheck() {
    if (!settings) return
    if (!settings.workerUrl || !settings.workerSecret) {
      setCheckState({ kind: 'error', message: 'Worker not configured. Open Settings to set the API endpoint.' })
      return
    }
    setCheckState({ kind: 'loading' })
    try {
      const article = await extractor()
      if (!article) {
        setCheckState({ kind: 'error', message: "Couldn't read the article on this page. Try a news site." })
        return
      }
      const res = await runMatchViaOffscreen(article)
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
          setCheckState({ kind: 'error', message: `Couldn't load markets: ${res.reason.replace('cache_refresh_failed:', '')}` })
        } else if (res.reason?.startsWith('match_error')) {
          setCheckState({ kind: 'error', message: res.reason.replace('match_error:', 'Match error: ') })
        } else if (res.reason?.startsWith('below_floor')) {
          // Show diagnostics from offscreen so we know whether it's an
          // empty cache, a genuine "no match", or a threshold issue.
          const diag = res.reason.replace('below_floor:', '')
          setCheckState({ kind: 'error', message: `No match (${diag})` })
        } else if (res.reason) {
          // Catch-all: any other reason (offscreen exception, OS_ERROR
          // bubbled up, etc) — surface verbatim instead of hiding under
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
    cacheSize: cache.count,
    cacheAge: cache.lastUpdated ? formatRelative(cache.lastUpdated) : '—',
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
              onStart={startCheck}
              onBack={() => setCheckState({ kind: 'idle' })}
              onRetry={startCheck}
              onOpenMarket={() => {
                if (!lastMatch) return
                void trackEvent('match_clicked', settings, { color: lastMatch.color })
                window.open(
                  buildMarketUrl(lastMatch.market.slug),
                  '_blank',
                  'noopener,noreferrer',
                )
              }}
              onTrade={() => setTab('Trade')}
            />
          )}
          {tab === 'Trade' && (
            <TradeTabWired
              match={lastMatch}
              settings={settings}
              onPickMatch={() => {
                setTab('Check')
                if (checkState.kind !== 'success') void startCheck()
              }}
              onOpenSettings={() => setTab('Settings')}
              onMatchOpenedExternally={(market) => {
                void trackEvent('match_clicked', settings, { color: 'blue' })
                window.open(buildMarketUrl(market.slug), '_blank', 'noopener,noreferrer')
              }}
            />
          )}
          {tab === 'History' && (
            <HistoryTab
              state={historyState}
              onSelect={(row) => {
                // Open the originating article in a new tab via stored pageUrl
                void (async () => {
                  const r = (await sendToBackground({ type: 'GET_HISTORY' })) as Extract<
                    ResponseMessage,
                    { type: 'HISTORY_RESPONSE' }
                  >
                  const item = r.items.find(
                    (x) => x.question === row.q && x.pageDomain === row.src,
                  )
                  if (item?.pageUrl) window.open(item.pageUrl, '_blank', 'noopener,noreferrer')
                })()
              }}
              onClear={() => {
                void (async () => {
                  await sendToBackground({ type: 'CLEAR_HISTORY' })
                  setHistoryState({ kind: 'empty' })
                })()
              }}
            />
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
// WalletSlot — read-only wallet info + wipe button inside Settings
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
        <div style={{ fontFamily: 'Marck Script', fontSize: 11.5 }}>
          EOA {short(wallet.address)}
        </div>
        <div
          style={{
            fontFamily: 'Marck Script',
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
