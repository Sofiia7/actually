import React, { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { IceCard } from './components/IceCard'
import { Etched } from './components/Etched'
import { GlassButton } from './components/GlassButton'
import { NeutralScanner } from './components/NeutralScanner'
import { LinkAction } from './components/LinkAction'
import { toneDark } from './colors'

import type { Settings as SettingsT } from '../shared/types'
import type { MatchResult, PolyMarket } from '@actually/core'
import type { SerializableWalletState } from '../shared/messages'
import { GEO_FAIL_OPEN } from '../shared/constants'
import { findOutcomeIndex, shortHash } from '@actually/core'
import { trackEvent } from '../background/telemetry'
import type { GeoErrorReason } from '../background/geo'
import { MarketAnalytics } from './trade/Analytics'
import * as om from './trade/orderMath'
import {
  disconnectWalletViaOffscreen,
  getGeoViaOffscreen,
  orderbookSnapshotViaOffscreen,
  placeOrderViaOffscreen,
  pollConnectViaOffscreen,
  restoreWalletViaOffscreen,
  startConnectViaOffscreen,
} from './ops'

// Widget-side wallet shape (subset of background WalletState).
type WalletState = SerializableWalletState

// =============================================================
// Props
// =============================================================
export interface TradeTabWiredProps {
  match: MatchResult | null
  /** Headline of the page the match was run against — shown as match context. */
  articleHeadline?: string | null
  settings: SettingsT
  onPickMatch: () => void
  onOpenSettings: () => void
  onMatchOpenedExternally: (market: PolyMarket) => void
}

type ConnectStage =
  | { kind: 'idle' }
  | { kind: 'connecting'; uri: string | null; qrDataUrl: string | null; error?: string }

type GeoInfo = {
  blocked: boolean
  country: string
  unknown: boolean
  errorReason?: GeoErrorReason
} | null

// =============================================================
export const TradeTabWired: React.FC<TradeTabWiredProps> = ({
  match,
  articleHeadline,
  settings,
  onPickMatch,
  onOpenSettings,
  onMatchOpenedExternally,
}) => {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [geo, setGeo] = useState<GeoInfo>(null)
  const [loaded, setLoaded] = useState(false)
  const [connect, setConnect] = useState<ConnectStage>({ kind: 'idle' })

  // Restore wallet + geo on mount — both are independent offscreen RPCs,
  // so fire them in parallel and unblock UI as soon as both resolve.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const hasWorker = Boolean(settings.workerUrl && settings.workerSecret)
      const [w, g] = await Promise.all([
        restoreWalletViaOffscreen().catch(() => null),
        hasWorker ? getGeoViaOffscreen().catch(() => null) : Promise.resolve(null),
      ])
      if (cancelled) return
      setWallet(w)
      if (g) setGeo(g)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [settings.workerUrl, settings.workerSecret])

  // Render the WC QR whenever a new URI comes in
  useEffect(() => {
    if (connect.kind !== 'connecting' || !connect.uri) return
    let cancelled = false
    void QRCode.toDataURL(connect.uri, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setConnect((s) => (s.kind === 'connecting' ? { ...s, qrDataUrl: url } : s))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [connect])

  async function startConnect() {
    setConnect({ kind: 'connecting', uri: null, qrDataUrl: null })
    try {
      const sessionId = await startConnectViaOffscreen()
      // Poll until done. 5 minutes is enough for a user to unlock their
      // wallet app, scan the QR, and approve — beyond that the popup is
      // almost certainly closed/abandoned, and an active poll loop just
      // burns the offscreen document and the WC relay session.
      const deadline = Date.now() + 5 * 60 * 1000
      let lastUri: string | undefined
      while (Date.now() < deadline) {
        const s = await pollConnectViaOffscreen(sessionId)
        if (s.uri && s.uri !== lastUri) {
          lastUri = s.uri
          setConnect({ kind: 'connecting', uri: s.uri, qrDataUrl: null })
        }
        if (s.stage === 'done' && s.wallet) {
          setWallet(s.wallet)
          setConnect({ kind: 'idle' })
          return
        }
        if (s.stage === 'error') {
          setConnect({ kind: 'connecting', uri: lastUri ?? null, qrDataUrl: null, error: humanError(s.error ?? 'connect_failed') })
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      setConnect({ kind: 'connecting', uri: lastUri ?? null, qrDataUrl: null, error: 'Connect timed out.' })
    } catch (err) {
      setConnect({ kind: 'connecting', uri: null, qrDataUrl: null, error: humanError(String(err)) })
    }
  }

  async function doDisconnect() {
    await disconnectWalletViaOffscreen()
    setWallet(null)
  }

  if (!loaded) {
    return (
      <PanelLoading message="restoring session…" />
    )
  }

  // Block on a confirmed restricted country, and — when the build is
  // fail-closed (prod default, see GEO_FAIL_OPEN) — also when the region
  // couldn't be verified at all.
  const geoConfirmedBlock = geo != null && geo.blocked && !geo.unknown
  const geoUnknownBlock = geo != null && geo.unknown && !GEO_FAIL_OPEN
  if (geoConfirmedBlock || geoUnknownBlock) {
    return (
      <Panel>
        <ErrorBanner>
          {geoUnknownBlock
            ? "Couldn't verify your region, so trading is paused. Check your connection and reopen the popup. Discovery still works on the Check tab."
            : `Trading is not available in your region (${geo!.country}). Discovery still works on the Check tab.`}
        </ErrorBanner>
      </Panel>
    )
  }

  if (!match) {
    return (
      <Panel>
        <Etched
          size={14}
          weight={300}
          italic
          family="serif"
          color="rgba(35,45,70,.65)"
          style={{ textAlign: 'center', lineHeight: 1.4 }}
        >
          No story checked yet.
        </Etched>
        <Etched
          size={12}
          weight={300}
          color="rgba(35,45,70,.45)"
          style={{ textAlign: 'center' }}
        >
          Run <b>Check</b> on a news page first — the matched market appears here for one-click trading.
        </Etched>
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center' }}>
          <GlassButton size="md" onClick={onPickMatch}>Open Check</GlassButton>
        </div>
      </Panel>
    )
  }

  if (connect.kind === 'connecting') {
    return (
      <Panel>
        <Etched size={13} weight={400}>Scan the QR with your wallet</Etched>
        <Etched size={11} weight={300} color="rgba(35,45,70,.55)">
          Or copy the connection link and paste it into your wallet.
        </Etched>
        {connect.qrDataUrl ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
            <img src={connect.qrDataUrl} width={200} height={200} alt="WalletConnect QR code" />
          </div>
        ) : (
          <div style={{ padding: 18, textAlign: 'center', opacity: 0.6 }}>preparing…</div>
        )}
        {connect.uri && (
          <button
            type="button"
            onClick={(e) => {
              void navigator.clipboard.writeText(connect.uri!)
              const t = e.currentTarget
              const prev = t.textContent
              t.textContent = 'Copied ✓'
              setTimeout(() => { t.textContent = prev }, 1500)
            }}
            style={{
              display: 'block', width: '100%', textAlign: 'center', cursor: 'pointer',
              padding: '10px 14px', borderRadius: 8,
              background: 'rgba(255,255,255,.09)',
              border: '1px solid rgba(255,255,255,.32)',
              fontFamily: 'Marck Script', fontSize: 13, color: 'rgba(18,26,48,.85)',
            }}
          >
            Copy connection link
          </button>
        )}
        {connect.error && <ErrorBanner>{connect.error}</ErrorBanner>}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <GlassButton size="sm" onClick={() => setConnect({ kind: 'idle' })}>Cancel</GlassButton>
        </div>
      </Panel>
    )
  }

  return (
    <TradeReady
      match={match}
      articleHeadline={articleHeadline}
      wallet={wallet}
      settings={settings}
      geoUnknown={geo?.unknown ?? false}
      onConnect={startConnect}
      onDisconnect={doDisconnect}
      onOpenSettings={onOpenSettings}
      onPickMatch={onPickMatch}
      onOpenExternal={() => onMatchOpenedExternally(match.market)}
    />
  )
}

// =============================================================
// Ready state — market preview + (connect OR order form)
// =============================================================
interface ReadyProps {
  match: MatchResult
  articleHeadline?: string | null
  wallet: WalletState | null
  settings: SettingsT
  geoUnknown: boolean
  onConnect: () => void
  onDisconnect: () => void
  onOpenSettings: () => void
  onPickMatch: () => void
  onOpenExternal: () => void
}

const TradeReady: React.FC<ReadyProps> = ({
  match,
  articleHeadline,
  wallet,
  settings,
  geoUnknown,
  onConnect,
  onDisconnect,
  onOpenSettings,
  onPickMatch,
  onOpenExternal,
}) => {
  const yesIdx = findOutcomeIndex(match.market.outcomes, 'Yes')
  const pct = Math.round((match.freshPrice ?? match.probability) * 100)
  const yesTokenId = match.market.clobTokenIds[yesIdx]

  return (
    <Panel>
      {geoUnknown && (
        <ErrorBanner>
          Couldn't verify region. Polymarket itself will reject restricted regions at order time.
        </ErrorBanner>
      )}

      <MatchContext
        headline={articleHeadline}
        confidence={match.confidence}
        lowConfidence={match.lowConfidence}
        hasAlternatives={match.alternatives.length > 0}
        onPickMatch={onPickMatch}
      />

      <IceCard pct={pct} intensity={1} padding="13px 14px" borderRadius={10}>
        <Etched
          size={13.5}
          weight={400}
          style={{ display: 'block', lineHeight: 1.3, marginBottom: 6 }}
        >
          {match.market.question}
        </Etched>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontFamily: 'Marck Script',
              fontSize: 38,
              fontWeight: 400,
              color: toneDark(pct, 0.97),
              letterSpacing: '-0.025em',
              textShadow: '0 1px 0 rgba(255,255,255,.55)',
              lineHeight: 1,
            }}
          >
            {pct}%
          </span>
          <Etched size={12} weight={300} color="rgba(35,45,70,.55)">
            YES chance
          </Etched>
        </div>
        <LinkAction onClick={onOpenExternal}>Open on Polymarket →</LinkAction>
      </IceCard>

      {wallet ? (
        <>
          <MarketAnalytics market={match.market} yesTokenId={yesTokenId} />
          <OrderFormWired
            match={match}
            settings={settings}
            yesIdx={yesIdx}
            onDisconnect={onDisconnect}
          />
        </>
      ) : (
        <ConnectPanel onConnect={onConnect} onOpenSettings={onOpenSettings} />
      )}
    </Panel>
  )
}

// =============================================================
// Connect panel — shown when no wallet session restored
// =============================================================
const ConnectPanel: React.FC<{ onConnect: () => void; onOpenSettings: () => void }> = ({
  onConnect,
  onOpenSettings,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Etched size={12} weight={300} color="rgba(35,45,70,.6)">
      Connect a wallet to place a builder-attributed order in one signature.
    </Etched>
    <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
      v1 supports existing Polymarket accounts (Safe wallet). New to Polymarket?
      Sign in once at polymarket.com first — fresh deposit wallets aren't supported yet.
    </Etched>
    <GlassButton size="md" full onClick={onConnect}>Connect wallet</GlassButton>
    <div style={{ textAlign: 'center' }}>
      <LinkAction onClick={onOpenSettings}>Configure Worker first →</LinkAction>
    </div>
  </div>
)

// =============================================================
// OrderFormWired — full v2 trade flow inside design chrome
// =============================================================
interface OrderFormProps {
  match: MatchResult
  settings: SettingsT
  yesIdx: number
  onDisconnect: () => void
}

const CAP_PCT = 0.02 // market (FOK) max slippage cap
const WARN_SLIPPAGE = 0.05
const HARD_SLIPPAGE = 0.2 // block submit above this

const OrderFormWired: React.FC<OrderFormProps> = ({
  match,
  settings,
  yesIdx,
  onDisconnect,
}) => {
  const [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT')
  const [side, setSide] = useState<'BUY_YES' | 'BUY_NO'>('BUY_YES')
  const [sizeUsd, setSizeUsd] = useState(20)
  const [priceInput, setPriceInput] = useState('')
  const [book, setBook] = useState<{ bestBid: number | null; bestAsk: number | null; spread: number | null }>(
    { bestBid: null, bestAsk: null, spread: null },
  )
  const [estimate, setEstimate] = useState<{ effectivePrice: number; slippage: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  // Confirm step before the wallet signature prompt (ТЗ §6.5) — a misclick on
  // "Place order" opens this summary, not the wallet, so the user reviews
  // side/size/price/payout before committing to a signature.
  const [confirming, setConfirming] = useState(false)

  // `order_form_opened` belongs at OrderForm mount — it measures intent.
  useEffect(() => {
    void trackEvent('order_form_opened', settings, { market_id_hash: shortHash(match.market.id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const noIdx = findOutcomeIndex(match.market.outcomes, 'No')
  const sideIdx = side === 'BUY_YES' ? yesIdx : noIdx
  const tokenId = match.market.clobTokenIds[sideIdx]
  const tick = match.market.tickSize ?? (match.market.negRisk ? '0.001' : '0.01')

  const limitPrice = parseFloat(priceInput)
  const capPrice = book.bestAsk != null ? om.marketCapPrice(book.bestAsk, CAP_PCT, tick) : null
  // Price that actually governs the order: limit price, or the market cap.
  const activePrice =
    orderType === 'MARKET' ? capPrice : Number.isFinite(limitPrice) ? limitPrice : null
  const shares = activePrice ? om.sharesFor(sizeUsd, activePrice) : 0

  // Top-of-book for the selected side's token; prefill the limit price with the
  // best ask each time the traded token changes (side flip / new match).
  useEffect(() => {
    let cancelled = false
    if (!tokenId) {
      setBook({ bestBid: null, bestAsk: null, spread: null })
      return
    }
    void (async () => {
      const snap = await orderbookSnapshotViaOffscreen(tokenId)
      if (cancelled) return
      setBook({ bestBid: snap.bestBid, bestAsk: snap.bestAsk, spread: snap.spread })
      if (snap.bestAsk != null) setPriceInput(String(om.roundToTick(snap.bestAsk, tick)))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId])

  // Depth-walk fill estimate — only meaningful for a MARKET (taker) order.
  useEffect(() => {
    let cancelled = false
    setEstimate(null)
    if (orderType !== 'MARKET' || !tokenId || shares <= 0) return
    void (async () => {
      const snap = await orderbookSnapshotViaOffscreen(tokenId, shares)
      if (!cancelled) setEstimate(snap.estimate)
    })()
    return () => { cancelled = true }
  }, [orderType, tokenId, shares])

  const effPrice =
    orderType === 'MARKET' ? estimate?.effectivePrice ?? capPrice ?? 0 : limitPrice || 0
  const effShares = om.sharesFor(sizeUsd, effPrice)
  const payout = om.maxPayout(effShares)
  const ret = om.returnFraction(sizeUsd, effShares)
  const slippage = orderType === 'MARKET' ? estimate?.slippage ?? null : null
  const makerTaker = om.makerOrTaker(orderType, limitPrice || 0, {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
  })

  const limitInvalid = orderType === 'LIMIT' && !om.isValidTickPrice(limitPrice, tick)
  const noLiquidity = orderType === 'MARKET' && capPrice == null
  const submitDisabled =
    submitting ||
    !tokenId ||
    sizeUsd <= 0 ||
    limitInvalid ||
    noLiquidity ||
    (slippage != null && slippage > HARD_SLIPPAGE)

  async function onSubmit() {
    const price = orderType === 'MARKET' ? capPrice : limitPrice
    if (!tokenId || price == null || !Number.isFinite(price)) return
    setSubmitting(true)
    setResult(null)
    try {
      const r = await placeOrderViaOffscreen({
        tokenId,
        side,
        sizeUsd,
        price,
        negRisk: match.market.negRisk ?? false,
        tickSize: match.market.tickSize,
        orderType,
        makerTaker,
      })
      setResult({ ok: r.ok, msg: r.ok ? `Order placed${r.orderId ? ` · ${r.orderId.slice(0, 10)}…` : ''}` : `Failed: ${r.error}` })
    } catch (err) {
      setResult({ ok: false, msg: `Error: ${String(err)}` })
    } finally {
      setSubmitting(false)
    }
  }

  const fmtC = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}¢`)
  const tickN = parseFloat(tick)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* order type */}
      <div style={{ display: 'flex', gap: 8 }}>
        <GlassButton size="sm" full onClick={() => setOrderType('LIMIT')} style={sidePillStyle(orderType === 'LIMIT')}>
          Limit
        </GlassButton>
        <GlassButton size="sm" full onClick={() => setOrderType('MARKET')} style={sidePillStyle(orderType === 'MARKET')}>
          Market
        </GlassButton>
      </div>

      {/* side */}
      <div style={{ display: 'flex', gap: 8 }}>
        <GlassButton size="md" full onClick={() => setSide('BUY_YES')} style={sidePillStyle(side === 'BUY_YES')}>
          BUY YES
        </GlassButton>
        <GlassButton size="md" full onClick={() => setSide('BUY_NO')} style={sidePillStyle(side === 'BUY_NO')}>
          BUY NO
        </GlassButton>
      </div>

      {/* top of book */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(35,45,70,.6)' }}>
        <span>bid {fmtC(book.bestBid)}</span>
        <span>ask {fmtC(book.bestAsk)}</span>
        <span style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{makerTaker}</span>
      </div>

      {/* price (limit) or cap note (market) */}
      {orderType === 'LIMIT' ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="label">Limit price (per share, 0–1)</span>
          <input
            type="number"
            min={tick}
            max={1 - tickN}
            step={tick}
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            className="thin-glass"
          />
        </label>
      ) : (
        <div style={{ fontSize: 12, color: 'rgba(35,45,70,.7)' }}>
          Market — fills now, capped at {fmtC(capPrice)} ({Math.round(CAP_PCT * 100)}% max).
        </div>
      )}

      {/* size */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="label">Amount (USD)</span>
        <input
          type="number"
          min={1}
          step={1}
          value={sizeUsd}
          onChange={(e) => setSizeUsd(Number(e.target.value))}
          className="thin-glass"
        />
      </label>

      {/* summary */}
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: 'rgba(255,255,255,.06)',
          border: '1px solid rgba(255,255,255,.22)',
          fontSize: 12,
          lineHeight: 1.6,
          color: 'rgba(35,45,70,.8)',
        }}
      >
        <Row
          label={orderType === 'MARKET' ? 'Est. fill' : 'Limit price'}
          value={fmtC(orderType === 'MARKET' ? effPrice : Number.isFinite(limitPrice) ? limitPrice : null)}
        />
        <Row label="Shares" value={effShares > 0 ? effShares.toFixed(2) : '—'} />
        <Row label="Max payout" value={`$${payout.toFixed(2)}`} />
        <Row label="Return %" value={`+${(ret * 100).toFixed(0)}%`} />
        {slippage != null && slippage > 0 && (
          <Row label="Slippage" value={`${(slippage * 100).toFixed(1)}%`} danger={slippage > WARN_SLIPPAGE} />
        )}
      </div>

      {limitInvalid && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          Enter a price between {fmtC(tickN)} and {fmtC(1 - tickN)}, in {tick} steps.
        </Etched>
      )}
      {noLiquidity && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          No asks on the book right now — can't market-buy. Try a limit order.
        </Etched>
      )}
      {slippage != null && slippage > WARN_SLIPPAGE && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          High slippage — orderbook is thin. Reduce size or use a limit order.
        </Etched>
      )}

      {!confirming ? (
        <GlassButton
          size="md"
          full
          disabled={submitDisabled}
          onClick={() => {
            setResult(null)
            setConfirming(true)
          }}
        >
          {`Place ${orderType === 'MARKET' ? 'market' : 'limit'} order · sign in wallet`}
        </GlassButton>
      ) : (
        <div
          style={{
            padding: '11px 13px',
            borderRadius: 8,
            background: 'rgba(255,255,255,.08)',
            border: '1px solid rgba(255,255,255,.32)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <Etched size={12.5} weight={400} style={{ marginBottom: 4 }}>
            Confirm {orderType === 'MARKET' ? 'market' : 'limit'} order
          </Etched>
          <Row label="Side" value={side === 'BUY_YES' ? 'BUY YES' : 'BUY NO'} />
          <Row label={orderType === 'MARKET' ? 'Est. fill' : 'Limit price'} value={fmtC(effPrice)} />
          <Row label="Amount" value={`$${sizeUsd.toFixed(2)}`} />
          <Row label="Shares" value={effShares > 0 ? effShares.toFixed(2) : '—'} />
          <Row label="Max payout" value={`$${payout.toFixed(2)}`} />
          {slippage != null && slippage > 0 && (
            <Row label="Slippage" value={`${(slippage * 100).toFixed(1)}%`} danger={slippage > WARN_SLIPPAGE} />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <GlassButton size="sm" full disabled={submitting} onClick={() => setConfirming(false)}>
              Cancel
            </GlassButton>
            <GlassButton
              size="md"
              full
              disabled={submitDisabled}
              onClick={async () => {
                await onSubmit()
                setConfirming(false)
              }}
            >
              {submitting ? 'Submitting…' : 'Sign in wallet'}
            </GlassButton>
          </div>
        </div>
      )}

      {result && (
        <Etched
          size={12}
          weight={300}
          color={result.ok ? 'rgba(30,110,60,.9)' : 'rgba(160,40,40,.9)'}
        >
          {result.msg}
        </Etched>
      )}

      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <LinkAction onClick={onDisconnect}>Disconnect wallet</LinkAction>
      </div>
    </div>
  )
}

// =============================================================
// Small helpers
// =============================================================
const Row: React.FC<{ label: string; value: string; danger?: boolean }> = ({ label, value, danger }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
    <span style={{ color: 'rgba(35,45,70,.55)' }}>{label}</span>
    <span style={{ fontWeight: 500, color: danger ? 'rgba(180,90,30,.95)' : undefined }}>{value}</span>
  </div>
)

// Match context (ТЗ §6.1) — article headline + match confidence, shown above
// the market card so the user can sanity-check the match (and jump back to
// Check to pick a different one). Always visible, wallet or not.
const MatchContext: React.FC<{
  headline?: string | null
  confidence: number
  lowConfidence: boolean
  hasAlternatives: boolean
  onPickMatch: () => void
}> = ({ headline, confidence, lowConfidence, hasAlternatives, onPickMatch }) => {
  const pct = Math.round(confidence * 100)
  return (
    <div
      style={{
        padding: '9px 12px',
        borderRadius: 8,
        background: 'rgba(255,255,255,.05)',
        border: '1px solid rgba(255,255,255,.20)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {headline ? (
        <>
          <Etched
            size={10.5}
            weight={300}
            color="rgba(35,45,70,.5)"
            style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}
          >
            From this page
          </Etched>
          <Etched size={12.5} weight={400} style={{ lineHeight: 1.3 }}>
            {headline.length > 120 ? `${headline.slice(0, 117)}…` : headline}
          </Etched>
        </>
      ) : (
        <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
          Matched market
        </Etched>
      )}
      <Etched size={11} weight={300} color="rgba(35,45,70,.55)">
        Matched at {pct}% confidence{lowConfidence ? ' · low — double-check it fits' : ''}.
      </Etched>
      {hasAlternatives && (
        <div style={{ marginTop: 2 }}>
          <LinkAction onClick={onPickMatch}>Not this market? Choose on Check →</LinkAction>
        </div>
      )}
    </div>
  )
}

const Panel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: '14px 18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
    {children}
  </div>
)

const PanelLoading: React.FC<{ message: string }> = ({ message }) => (
  <div style={{ padding: '40px 18px', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
    <NeutralScanner />
    <Etched size={13} weight={300} color="rgba(35,45,70,.55)">{message}</Etched>
  </div>
)

const ErrorBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      padding: '11px 13px',
      borderRadius: 8,
      background: 'rgba(200,140,40,.08)',
      border: '1px solid rgba(200,140,40,.38)',
    }}
  >
    <Etched size={12.5} weight={300} color="rgba(110,75,15,.85)" style={{ lineHeight: 1.45 }}>
      {children}
    </Etched>
  </div>
)

function sidePillStyle(active: boolean): React.CSSProperties {
  return active
    ? { background: 'rgba(255,255,255,.18)', borderColor: 'rgba(255,255,255,.6)' }
    : {}
}


function humanError(raw: string): string {
  if (raw.includes('wc_project_id_missing')) return 'WalletConnect project ID not configured.'
  if (raw.includes('builder_code_not_configured')) return 'Builder code missing in build.'
  if (raw.includes('geo_blocked')) return 'Trading is not available in your region.'
  if (raw.includes('geo_unavailable')) return "Couldn't verify your region — trading is paused. Check your connection and try again."
  if (raw.includes('worker_not_configured')) return 'Set Worker URL and secret in Settings first.'
  if (raw.includes('funder_not_found')) return 'No Polymarket account found for this wallet. v1 works with existing Polymarket accounts (Safe wallets). New to Polymarket? Sign in once at polymarket.com, then reconnect — fresh deposit wallets (POLY_1271) are coming soon.'
  if (raw.includes('funder_lookup_failed')) return "Couldn't reach Polymarket to look up your account. Check your connection and try again."
  return raw.replace(/^Error: /, '')
}

export type { GeoErrorReason }
