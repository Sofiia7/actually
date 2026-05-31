import React, { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { IceCard } from './components/IceCard'
import { Etched } from './components/Etched'
import { GlassButton } from './components/GlassButton'
import { NeutralScanner } from './components/NeutralScanner'
import { LinkAction } from './components/LinkAction'
import { toneDark } from './colors'

import type { MatchResult, PolyMarket, Settings as SettingsT } from '../shared/types'
import type { SerializableWalletState } from '../shared/messages'
import { findOutcomeIndex, safeJsonArray, shortHash } from '../background/util'
import { trackEvent } from '../background/telemetry'
import type { GeoErrorReason } from '../background/geo'
import { MarketAnalytics } from './trade/Analytics'
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
  settings: SettingsT
  onPickMatch: () => void
  onOpenSettings: () => void
  onMatchOpenedExternally: (market: PolyMarket) => void
}

type ConnectStage =
  | { kind: 'idle' }
  | { kind: 'connecting'; uri: string | null; qrSvg: string | null; error?: string }

type GeoInfo = {
  blocked: boolean
  country: string
  unknown: boolean
  errorReason?: GeoErrorReason
} | null

// =============================================================
export const TradeTabWired: React.FC<TradeTabWiredProps> = ({
  match,
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
    void QRCode.toString(connect.uri, { type: 'svg', margin: 1, width: 200 })
      .then((svg) => {
        if (!cancelled) setConnect((s) => (s.kind === 'connecting' ? { ...s, qrSvg: svg } : s))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [connect])

  async function startConnect() {
    setConnect({ kind: 'connecting', uri: null, qrSvg: null })
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
          setConnect({ kind: 'connecting', uri: s.uri, qrSvg: null })
        }
        if (s.stage === 'done' && s.wallet) {
          setWallet(s.wallet)
          setConnect({ kind: 'idle' })
          return
        }
        if (s.stage === 'error') {
          setConnect({ kind: 'connecting', uri: lastUri ?? null, qrSvg: null, error: humanError(s.error ?? 'connect_failed') })
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      setConnect({ kind: 'connecting', uri: lastUri ?? null, qrSvg: null, error: 'Connect timed out.' })
    } catch (err) {
      setConnect({ kind: 'connecting', uri: null, qrSvg: null, error: humanError(String(err)) })
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

  // Hard-block only on a confirmed restricted country
  if (geo?.blocked && !geo.unknown) {
    return (
      <Panel>
        <ErrorBanner>
          Trading is not available in your region ({geo.country}). Discovery still works on the Check tab.
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
          Or tap "Open in wallet" if your wallet app is on this device.
        </Etched>
        {connect.qrSvg ? (
          <div
            style={{ display: 'flex', justifyContent: 'center', padding: 12 }}
            dangerouslySetInnerHTML={{ __html: connect.qrSvg }}
          />
        ) : (
          <div style={{ padding: 18, textAlign: 'center', opacity: 0.6 }}>preparing…</div>
        )}
        {connect.uri && (
          <a
            href={connect.uri}
            style={{
              display: 'block', textAlign: 'center', textDecoration: 'none',
              padding: '10px 14px', borderRadius: 8,
              background: 'rgba(255,255,255,.09)',
              border: '1px solid rgba(255,255,255,.32)',
              fontFamily: 'Marck Script', fontSize: 13, color: 'rgba(18,26,48,.85)',
            }}
          >
            Open in wallet
          </a>
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
      wallet={wallet}
      settings={settings}
      geoUnknown={geo?.unknown ?? false}
      onConnect={startConnect}
      onDisconnect={doDisconnect}
      onOpenSettings={onOpenSettings}
      onOpenExternal={() => onMatchOpenedExternally(match.market)}
    />
  )
}

// =============================================================
// Ready state — market preview + (connect OR order form)
// =============================================================
interface ReadyProps {
  match: MatchResult
  wallet: WalletState | null
  settings: SettingsT
  geoUnknown: boolean
  onConnect: () => void
  onDisconnect: () => void
  onOpenSettings: () => void
  onOpenExternal: () => void
}

const TradeReady: React.FC<ReadyProps> = ({
  match,
  wallet,
  settings,
  geoUnknown,
  onConnect,
  onDisconnect,
  onOpenSettings,
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

      <MarketAnalytics market={match.market} yesTokenId={yesTokenId} />

      {wallet ? (
        <OrderFormWired
          match={match}
          wallet={wallet}
          settings={settings}
          yesIdx={yesIdx}
          onDisconnect={onDisconnect}
        />
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
  wallet: WalletState
  settings: SettingsT
  yesIdx: number
  onDisconnect: () => void
}

const OrderFormWired: React.FC<OrderFormProps> = ({
  match,
  wallet,
  settings,
  yesIdx,
  onDisconnect,
}) => {
  const [side, setSide] = useState<'BUY_YES' | 'BUY_NO'>('BUY_YES')
  const [sizeUsd, setSizeUsd] = useState(20)
  const [slippage, setSlippage] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // `order_form_opened` belongs at OrderForm mount, not at submit time —
  // it measures intent ("user reached the form"), not action.
  useEffect(() => {
    void trackEvent('order_form_opened', settings, { market_id_hash: shortHash(match.market.id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const noIdx = findOutcomeIndex(match.market.outcomes, 'No')
  const sideIdx = side === 'BUY_YES' ? yesIdx : noIdx
  const tokenId = match.market.clobTokenIds[sideIdx]
  // Price is per-outcome — selling YES at 23¢ means buying NO at 77¢.
  // freshPrice tracks the YES side, so flip it for BUY_NO.
  const prices = safeJsonArray(match.market.outcomePrices)
  const sidePrice = parseFloat(prices[sideIdx] ?? '0')
  const price = match.freshPrice != null
    ? (side === 'BUY_YES' ? match.freshPrice : 1 - match.freshPrice)
    : sidePrice

  // Slippage estimate from orderbook (best-effort, sourced from CLOB)
  useEffect(() => {
    let cancelled = false
    setSlippage(null)
    if (!tokenId || !price || !Number.isFinite(sizeUsd) || sizeUsd <= 0) return
    void (async () => {
      try {
        const snap = await orderbookSnapshotViaOffscreen(tokenId)
        // Crude slippage proxy: spread relative to bestAsk. The full
        // depth-walking estimator runs offscreen but isn't exposed in
        // the snapshot — we surface spread as a conservative signal.
        if (snap.bestAsk != null && snap.spread != null && snap.bestAsk > 0) {
          if (!cancelled) setSlippage(Math.max(0, snap.spread / snap.bestAsk))
        }
      } catch {
        /* ignore */
      }
    })()
    return () => { cancelled = true }
    // `wallet.address` is a stable string identity — depending on the
    // wallet object itself would refire this effect on every parent
    // re-render even when nothing relevant changed.
  }, [tokenId, sizeUsd, price, wallet.address])

  async function onSubmit() {
    if (!tokenId || !price) return
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
      })
      setResult({ ok: r.ok, msg: r.ok ? `Order placed${r.orderId ? ` · ${r.orderId.slice(0, 10)}…` : ''}` : `Failed: ${r.error}` })
    } catch (err) {
      setResult({ ok: false, msg: `Error: ${String(err)}` })
    } finally {
      setSubmitting(false)
    }
  }

  const shares = price > 0 ? sizeUsd / price : 0
  const maxPayout = shares
  const ret = sizeUsd > 0 ? (maxPayout - sizeUsd) / sizeUsd : 0

  const submitDisabled = submitting || !tokenId || !price || sizeUsd <= 0 || (slippage != null && slippage > 0.2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <GlassButton size="md" full onClick={() => setSide('BUY_YES')} style={sidePillStyle(side === 'BUY_YES')}>
          BUY YES
        </GlassButton>
        <GlassButton size="md" full onClick={() => setSide('BUY_NO')} style={sidePillStyle(side === 'BUY_NO')}>
          BUY NO
        </GlassButton>
      </div>

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
        <Row label="Max payout" value={`$${maxPayout.toFixed(2)}`} />
        <Row label="Return %" value={`+${(ret * 100).toFixed(0)}%`} />
        {slippage != null && slippage > 0 && (
          <Row
            label="Slippage"
            value={`${(slippage * 100).toFixed(1)}%`}
            danger={slippage > 0.05}
          />
        )}
      </div>

      {slippage != null && slippage > 0.05 && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          High slippage — orderbook is thin. Reduce size or wait.
        </Etched>
      )}

      <GlassButton size="md" full disabled={submitDisabled} onClick={onSubmit}>
        {submitting ? 'Submitting…' : `Place order · sign in wallet`}
      </GlassButton>

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
  if (raw.includes('worker_not_configured')) return 'Set Worker URL and secret in Settings first.'
  if (raw.includes('funder_not_found')) return 'No Polymarket Safe found for this wallet. Sign in on polymarket.com once, then retry.'
  return raw.replace(/^Error: /, '')
}

export type { GeoErrorReason }
