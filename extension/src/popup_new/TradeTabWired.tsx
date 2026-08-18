import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { IceCard } from './components/IceCard'
import { Etched } from './components/Etched'
import { GlassButton } from './components/GlassButton'
import { NeutralScanner } from './components/NeutralScanner'
import { LinkAction } from './components/LinkAction'
import { PositionsPanel } from './components/PositionsPanel'
import { toneDark } from './colors'

import type { OpenOrderSummary, Position, Settings as SettingsT } from '../shared/types'
import type { MatchResult, PolyMarket } from '@actually/core'
import type { SerializableWalletState } from '../shared/messages'
import { GEO_FAIL_OPEN, MAX_ORDER_USD } from '../shared/constants'
import { findOutcomeIndex, isBelowMinOrderSize, minOrderShares, minOrderUsd, shortHash, shortRef } from '@actually/core'
import { trackEvent } from '../background/telemetry'
import { logTrade } from '../background/tradeLog'
import type { GeoErrorReason } from '../background/geo'
import { MarketAnalytics } from './trade/Analytics'
import * as om from './trade/orderMath'
import {
  cancelOrderViaOffscreen,
  disconnectWalletViaOffscreen,
  getGeoViaOffscreen,
  getOpenOrdersViaOffscreen,
  getPositionsViaOffscreen,
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
  /** 'page' (default) — a real, scored match from Check. 'history' — the user picked this market
   * directly from History, so there is no real confidence score to show. */
  matchSource?: 'page' | 'history'
  settings: SettingsT
  onPickMatch: () => void
  onOpenSettings: () => void
  onMatchOpenedExternally: (market: PolyMarket) => void
}

type ConnectStage =
  | { kind: 'idle' }
  | {
      kind: 'connecting'
      uri: string | null
      qrDataUrl: string | null
      error?: string
      /** True once the QR was approved and we're waiting on the wallet's
       * SECOND prompt (the CLOB-auth signature). */
      signing?: boolean
    }

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
  matchSource = 'page',
  settings,
  onPickMatch,
  onOpenSettings,
  onMatchOpenedExternally,
}) => {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [geo, setGeo] = useState<GeoInfo>(null)
  const [loaded, setLoaded] = useState(false)
  const [connect, setConnect] = useState<ConnectStage>({ kind: 'idle' })

  // Portfolio (positions + open orders) — previously the only way to see
  // either was leaving the extension for polymarket.com directly.
  const [positions, setPositions] = useState<Position[]>([])
  const [openOrders, setOpenOrders] = useState<OpenOrderSummary[]>([])
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  // Bumped on every new startConnect() call and on Cancel/unmount. A running
  // connect loop checks this before every state update it makes — without
  // it, Connect → Cancel → Connect again leaves the FIRST loop still
  // polling in the background, and it can clobber the second attempt's live
  // QR/wallet state with its own (stale) result once it eventually resolves.
  const connectGenRef = useRef(0)
  useEffect(() => () => { connectGenRef.current++ }, [])

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

      // No wallet on disk yet — but a connect may still be running in the
      // offscreen document from before this popup was (re)opened. Chrome
      // closes the popup on any focus loss, so the single most common way to
      // approve a QR — switching to the wallet app — always destroys the
      // popup that started the flow. Without this the user came back to a
      // plain "Connect wallet" screen, with the real connect still waiting on
      // a signature they had no way to see.
      if (w) return
      const pending = await pollConnectViaOffscreen().catch(() => null)
      if (cancelled || !pending) return
      if (pending.stage === 'done' && pending.wallet) {
        setWallet(pending.wallet)
        return
      }
      if (pending.stage === 'pending' || pending.stage === 'awaiting_approval' || pending.stage === 'signing') {
        setConnect({
          kind: 'connecting',
          uri: pending.uri ?? null,
          qrDataUrl: null,
          signing: pending.stage === 'signing',
        })
        void pumpConnect(undefined, ++connectGenRef.current)
        return
      }
      // A connect that FAILED while the popup was shut. `unknown_session`
      // just means there was never one to report; anything else is a real
      // reason the user needs to see. Dropping it here (as this did) is why a
      // failing connect still looked like a connect that had never happened.
      if (pending.stage === 'error' && pending.error && pending.error !== 'unknown_session') {
        setConnect({
          kind: 'connecting',
          uri: null,
          qrDataUrl: null,
          error: humanError(pending.error),
        })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.workerUrl, settings.workerSecret])

  // Bumped on every refreshPortfolio() call. wallet-connect, a cancel's
  // finally-block, the manual Refresh link, and a post-order refresh can all
  // trigger overlapping calls with no inherent ordering — without this, a
  // slower EARLIER call resolving after a faster LATER one would clobber the
  // fresher state (e.g. resurrecting a just-cancelled order in the UI).
  const portfolioGenRef = useRef(0)

  async function refreshPortfolio() {
    if (!wallet) return
    const gen = ++portfolioGenRef.current
    setPortfolioLoading(true)
    try {
      const [pRes, oRes] = await Promise.all([getPositionsViaOffscreen(), getOpenOrdersViaOffscreen()])
      if (portfolioGenRef.current !== gen) return // superseded by a newer refresh — don't clobber its result
      // A fetch failure (rate limit, transient CLOB/data-api error, offscreen
      // hiccup) must not read as "you have no positions" — keep whatever we
      // last knew and surface the error instead of silently clearing it.
      const errors = [!pRes.ok ? pRes.error : null, !oRes.ok ? oRes.error : null].filter(Boolean) as string[]
      if (errors.some((e) => e === 'no_wallet')) {
        // The offscreen side says there is no usable session, while this
        // component is still rendering a full order ticket from the wallet it
        // restored on mount. That split is what produced a popup where every
        // control was live but every action answered `no_wallet` — surface
        // the truth and fall back to the Connect panel instead.
        setWallet(null)
        setPortfolioError(null)
        return
      }
      if (errors.length > 0) {
        setPortfolioError(errors.join('; '))
      } else {
        setPortfolioError(null)
        setPositions(pRes.ok ? pRes.positions ?? [] : [])
        setOpenOrders(oRes.ok ? oRes.orders ?? [] : [])
      }
    } finally {
      if (portfolioGenRef.current === gen) setPortfolioLoading(false)
    }
  }

  useEffect(() => {
    if (!wallet) {
      setPositions([])
      setOpenOrders([])
      setPortfolioError(null)
      setCancelError(null)
      return
    }
    void refreshPortfolio()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address])

  async function onCancelOpenOrder(orderId: string) {
    // `LinkAction` renders a plain <a> (no native `disabled`, unlike a
    // <button>), so nothing else stops a rapid double-click from firing this
    // twice before the "Cancelling…" label re-renders. Guard synchronously.
    if (cancellingId) return
    setCancellingId(orderId)
    try {
      const r = await cancelOrderViaOffscreen(orderId)
      setCancelError(r.ok ? null : r.error ?? 'unknown_error')
    } catch (err) {
      setCancelError(String(err))
    } finally {
      setCancellingId(null)
      void refreshPortfolio()
    }
  }

  // Render the WC QR whenever a new URI comes in.
  //
  // Keyed on the URI STRING, not the connect object. Keyed on the object this
  // spun forever: the effect's own setConnect spreads into a fresh object, so
  // `connect` had a new identity on every pass, which re-ran the effect, which
  // re-encoded the QR, which set state again. While the QR screen was up the
  // popup sat in an unbroken render loop — burning CPU and starving everything
  // else the popup was trying to do, including the poll that advances the
  // connect. The URI is the only input the encoding actually depends on.
  const connectUri = connect.kind === 'connecting' ? connect.uri : null
  useEffect(() => {
    if (!connectUri) return
    let cancelled = false
    void QRCode.toDataURL(connectUri, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setConnect((s) => (s.kind === 'connecting' ? { ...s, qrDataUrl: url } : s))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [connectUri])

  /**
   * Drive one connect to completion.
   *
   * `sessionId` is optional so a popup that was closed mid-connect — which
   * Chrome does on any focus loss, including switching to the wallet app —
   * can rejoin the flow still running in the offscreen document instead of
   * abandoning it and starting a competing one.
   */
  async function pumpConnect(sessionId: string | undefined, gen: number) {
    const stale = () => connectGenRef.current !== gen
    try {
      // Poll until done. 5 minutes is enough for a user to unlock their
      // wallet app, scan the QR, and approve — beyond that the popup is
      // almost certainly closed/abandoned, and an active poll loop just
      // burns the offscreen document and the WC relay session.
      const deadline = Date.now() + 5 * 60 * 1000
      let lastUri: string | undefined
      while (Date.now() < deadline) {
        if (stale()) return // superseded by a Cancel or a newer connect attempt
        const s = await pollConnectViaOffscreen(sessionId)
        if (stale()) return
        if (s.uri && s.uri !== lastUri) {
          lastUri = s.uri
          setConnect({ kind: 'connecting', uri: s.uri, qrDataUrl: null })
        }
        if (s.stage === 'signing') {
          setConnect((prev) =>
            prev.kind === 'connecting' && prev.signing ? prev : { ...(prev.kind === 'connecting' ? prev : { kind: 'connecting' as const, uri: lastUri ?? null, qrDataUrl: null }), signing: true },
          )
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
      if (!stale()) {
        setConnect({ kind: 'connecting', uri: lastUri ?? null, qrDataUrl: null, error: 'Connect timed out.' })
      }
    } catch (err) {
      if (!stale()) {
        setConnect({ kind: 'connecting', uri: null, qrDataUrl: null, error: humanError(String(err)) })
      }
    }
  }

  async function startConnect() {
    const gen = ++connectGenRef.current
    setConnect({ kind: 'connecting', uri: null, qrDataUrl: null })
    try {
      const sessionId = await startConnectViaOffscreen()
      await pumpConnect(sessionId, gen)
    } catch (err) {
      if (connectGenRef.current === gen) {
        setConnect({ kind: 'connecting', uri: null, qrDataUrl: null, error: humanError(String(err)) })
      }
    }
  }

  function cancelConnect() {
    connectGenRef.current++ // orphan any in-flight startConnect() loop
    setConnect({ kind: 'idle' })
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
        {wallet && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <Etched size={12} weight={300} color="rgba(35,45,70,.55)">
              Connected: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </Etched>
            <LinkAction onClick={doDisconnect}>Disconnect wallet</LinkAction>
          </div>
        )}
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
        {wallet && (
          <PositionsPanel
            positions={positions}
            openOrders={openOrders}
            loading={portfolioLoading}
            cancellingId={cancellingId}
            onCancelOrder={onCancelOpenOrder}
            onRefresh={refreshPortfolio}
            portfolioError={portfolioError}
            cancelError={cancelError}
          />
        )}
      </Panel>
    )
  }

  if (connect.kind === 'connecting' && connect.signing && !connect.error) {
    // The QR is done with; the wallet is now holding a SECOND prompt (the
    // CLOB-auth signature). Showing the QR here — as this used to — made an
    // approved connect look like one that had never started.
    return (
      <Panel>
        <Etched size={13} weight={400}>Approve the signature in your wallet</Etched>
        <Etched size={11} weight={300} color="rgba(35,45,70,.6)" style={{ lineHeight: 1.45 }}>
          Wallet connected. It's now asking you to sign a one-time message that
          proves you own the account — open your wallet app to approve it. This
          signs nothing on-chain and costs no gas.
        </Etched>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}>
          <NeutralScanner />
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <GlassButton size="sm" onClick={cancelConnect}>Cancel</GlassButton>
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
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", fontSize: 13, color: 'rgba(18,26,48,.85)',
            }}
          >
            Copy connection link
          </button>
        )}
        {connect.error && <ErrorBanner>{connect.error}</ErrorBanner>}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <GlassButton size="sm" onClick={cancelConnect}>Cancel</GlassButton>
        </div>
      </Panel>
    )
  }

  return (
    <TradeReady
      match={match}
      articleHeadline={articleHeadline}
      matchSource={matchSource}
      wallet={wallet}
      settings={settings}
      geoUnknown={geo?.unknown ?? false}
      onConnect={startConnect}
      onDisconnect={doDisconnect}
      onOpenSettings={onOpenSettings}
      onPickMatch={onPickMatch}
      onOpenExternal={() => onMatchOpenedExternally(match.market)}
      positions={positions}
      openOrders={openOrders}
      portfolioLoading={portfolioLoading}
      portfolioError={portfolioError}
      cancellingId={cancellingId}
      cancelError={cancelError}
      onCancelOpenOrder={onCancelOpenOrder}
      onRefreshPortfolio={refreshPortfolio}
    />
  )
}

// =============================================================
// Ready state — market preview + (connect OR order form)
// =============================================================
interface ReadyProps {
  match: MatchResult
  articleHeadline?: string | null
  matchSource: 'page' | 'history'
  wallet: WalletState | null
  settings: SettingsT
  geoUnknown: boolean
  onConnect: () => void
  onDisconnect: () => void
  onOpenSettings: () => void
  onPickMatch: () => void
  onOpenExternal: () => void
  positions: Position[]
  openOrders: OpenOrderSummary[]
  portfolioLoading: boolean
  portfolioError: string | null
  cancellingId: string | null
  cancelError: string | null
  onCancelOpenOrder: (orderId: string) => void
  onRefreshPortfolio: () => void
}

const TradeReady: React.FC<ReadyProps> = ({
  match,
  articleHeadline,
  matchSource,
  wallet,
  settings,
  geoUnknown,
  onConnect,
  onDisconnect,
  onOpenSettings,
  onPickMatch,
  onOpenExternal,
  positions,
  openOrders,
  portfolioLoading,
  portfolioError,
  cancellingId,
  cancelError,
  onCancelOpenOrder,
  onRefreshPortfolio,
}) => {
  const yesIdx = findOutcomeIndex(match.market.outcomes, 'Yes')
  const pct = Math.round((match.freshPrice ?? match.probability) * 100)
  const yesTokenId = match.market.clobTokenIds[yesIdx]
  const positionsRef = useRef<HTMLDivElement | null>(null)

  // Market context card (question, %, "Open on Polymarket"). Position
  // depends on connect state: it leads while connected (context for the
  // order form below it), but takes a back seat to the Connect button
  // while disconnected — otherwise it's the only prominent thing on the
  // panel and "Open on Polymarket" reads as the primary action when it's
  // actually a secondary escape hatch (Check tab already offers the same
  // link).
  const marketCard = (
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
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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
  )

  return (
    <Panel>
      {geoUnknown && (
        <ErrorBanner>
          Couldn't verify region. Polymarket itself will reject restricted regions at order time.
        </ErrorBanner>
      )}

      <MatchContext
        headline={articleHeadline}
        source={matchSource}
        confidence={match.confidence}
        lowConfidence={match.lowConfidence}
        hasAlternatives={match.alternatives.length > 0}
        onPickMatch={onPickMatch}
      />

      {wallet ? (
        <>
          {/* What you hold, before what you might buy. The panel itself sits
              below the order ticket (the tab is entered from a matched market,
              so the ticket keeps its place), but a user opening the popup to
              check on their own money should not have to scroll past a buy
              form — let alone reconstruct their positions from the Check
              history — to find it. */}
          <PortfolioSummary
            positions={positions}
            openOrders={openOrders}
            loading={portfolioLoading}
            onView={() => positionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          />
          {marketCard}
          <MarketAnalytics market={match.market} yesTokenId={yesTokenId} />
          <OrderFormWired
            match={match}
            settings={settings}
            yesIdx={yesIdx}
            onDisconnect={onDisconnect}
            onPortfolioChanged={onRefreshPortfolio}
          />
          <div ref={positionsRef}>
            <PositionsPanel
              positions={positions}
              openOrders={openOrders}
              loading={portfolioLoading}
              cancellingId={cancellingId}
              onCancelOrder={onCancelOpenOrder}
              onRefresh={onRefreshPortfolio}
              portfolioError={portfolioError}
              cancelError={cancelError}
            />
          </div>
        </>
      ) : (
        <>
          <ConnectPanel
            onConnect={onConnect}
            onOpenSettings={onOpenSettings}
            workerConfigured={Boolean(settings.workerUrl && settings.workerSecret)}
          />
          {marketCard}
        </>
      )}
    </Panel>
  )
}

// =============================================================
// Connect panel — shown when no wallet session restored
// =============================================================
const ConnectPanel: React.FC<{
  onConnect: () => void
  onOpenSettings: () => void
  workerConfigured: boolean
}> = ({ onConnect, onOpenSettings, workerConfigured }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Etched size={12} weight={300} color="rgba(35,45,70,.6)">
      Connect a wallet to place a builder-attributed order in one signature.
    </Etched>
    <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
      v1 supports existing Polymarket accounts (Safe wallet). New to Polymarket?
      Sign in once at polymarket.com first — fresh deposit wallets aren't supported yet.
    </Etched>
    <GlassButton size="md" full onClick={onConnect}>Connect wallet</GlassButton>
    {!workerConfigured && (
      <div style={{ textAlign: 'center' }}>
        <LinkAction onClick={onOpenSettings}>Configure Worker first →</LinkAction>
      </div>
    )}
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
  onPortfolioChanged?: () => void
}

const CAP_PCT = 0.02 // market (FOK) max slippage cap
const WARN_SLIPPAGE = 0.05
const HARD_SLIPPAGE = 0.2 // block submit above this

const OrderFormWired: React.FC<OrderFormProps> = ({
  match,
  settings,
  yesIdx,
  onDisconnect,
  onPortfolioChanged,
}) => {
  const [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT')
  const [side, setSide] = useState<'BUY_YES' | 'BUY_NO'>('BUY_YES')
  const [sizeUsd, setSizeUsd] = useState(20)
  const [priceInput, setPriceInput] = useState('')
  const [book, setBook] = useState<{ bestBid: number | null; bestAsk: number | null; spread: number | null; error?: string }>(
    { bestBid: null, bestAsk: null, spread: null },
  )
  const [estimate, setEstimate] = useState<{ effectivePrice: number; slippage: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; orderId?: string } | null>(null)
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
      setBook({ bestBid: snap.bestBid, bestAsk: snap.bestAsk, spread: snap.spread, error: snap.error })
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
  const overOrderCap = sizeUsd > MAX_ORDER_USD

  // CLOB's floor is on SHARES, not dollars, so the USD minimum moves with the
  // price: $1 clears it at 15¢ and misses it at 31¢. Checked here because the
  // rejection would otherwise land only AFTER the wallet signature.
  const minShares = minOrderShares(match.market.minOrderSize)
  const minUsd = activePrice != null ? minOrderUsd(activePrice, match.market.minOrderSize) : null
  const belowMinSize =
    activePrice != null && isBelowMinOrderSize(sizeUsd, activePrice, match.market.minOrderSize)

  const submitDisabled =
    submitting ||
    !tokenId ||
    sizeUsd <= 0 ||
    overOrderCap ||
    belowMinSize ||
    limitInvalid ||
    noLiquidity ||
    (slippage != null && slippage > HARD_SLIPPAGE)

  async function onSubmit() {
    // Synchronous re-entrancy guard, checked before any state update: the
    // button's own `disabled={submitDisabled}` (which includes `submitting`)
    // is the primary guard, but that relies on React re-rendering the DOM
    // before a second click can land — not guaranteed for a very fast
    // double-click/double-tap. This closes that gap outright: a real-money
    // order button must never be double-submittable regardless of render
    // timing.
    if (submitting) return
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
        minOrderSize: match.market.minOrderSize,
        orderType,
        makerTaker,
      })
      setResult({
        ok: r.ok,
        msg: r.ok
          ? orderType === 'LIMIT'
            ? `Limit order placed — ${effShares.toFixed(2)} shares of ${side === 'BUY_YES' ? 'Yes' : 'No'} at ${fmtC(price)}. It rests on the book until it fills.`
            : `Order filled — ${effShares.toFixed(2)} shares of ${side === 'BUY_YES' ? 'Yes' : 'No'} for about $${sizeUsd.toFixed(2)}.`
          : `${humanError(r.error ?? 'unknown_error')}`,
        orderId: r.orderId,
      })
      void logTrade({
        kind: 'BUY',
        status: r.ok ? 'placed' : 'failed',
        question: match.market.question,
        marketSlug: match.market.eventSlug || match.market.slug,
        outcome: side === 'BUY_YES' ? 'Yes' : 'No',
        orderType,
        usd: sizeUsd,
        shares: effShares,
        price,
        ref: r.orderId,
        error: r.ok ? undefined : humanError(r.error ?? 'unknown_error'),
      })
      if (r.ok) onPortfolioChanged?.()
    } catch (err) {
      setResult({ ok: false, msg: `Error: ${String(err)}` })
      void logTrade({
        kind: 'BUY',
        status: 'failed',
        question: match.market.question,
        marketSlug: match.market.eventSlug || match.market.slug,
        outcome: side === 'BUY_YES' ? 'Yes' : 'No',
        orderType,
        usd: sizeUsd,
        price: price ?? undefined,
        error: String(err),
      })
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
        <GlassButton
          size="sm"
          full
          selected={orderType === 'LIMIT'}
          onClick={() => setOrderType('LIMIT')}
          style={sidePillStyle(orderType === 'LIMIT')}
        >
          Limit
        </GlassButton>
        <GlassButton
          size="sm"
          full
          selected={orderType === 'MARKET'}
          onClick={() => setOrderType('MARKET')}
          style={sidePillStyle(orderType === 'MARKET')}
        >
          Market
        </GlassButton>
      </div>

      {/* side */}
      <div style={{ display: 'flex', gap: 8 }}>
        <GlassButton
          size="md"
          full
          selected={side === 'BUY_YES'}
          onClick={() => setSide('BUY_YES')}
          style={sidePillStyle(side === 'BUY_YES')}
        >
          BUY YES
        </GlassButton>
        <GlassButton
          size="md"
          full
          selected={side === 'BUY_NO'}
          onClick={() => setSide('BUY_NO')}
          style={sidePillStyle(side === 'BUY_NO')}
        >
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
        <span className="label">Amount (USD, max ${MAX_ORDER_USD})</span>
        <input
          type="number"
          min={1}
          max={MAX_ORDER_USD}
          step={1}
          value={sizeUsd}
          onChange={(e) => setSizeUsd(Number(e.target.value))}
          className="thin-glass"
        />
        {overOrderCap && (
          <span style={{ fontSize: 11, color: '#E24B4A' }}>
            Orders are capped at ${MAX_ORDER_USD} per trade.
          </span>
        )}
        {!overOrderCap && belowMinSize && minUsd != null && (
          <span style={{ fontSize: 11, color: '#E24B4A' }}>
            Polymarket's minimum is {minShares} shares — at {fmtC(activePrice)} that's ${minUsd.toFixed(2)}.
          </span>
        )}
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
        <Row label="Max payout" value={effShares > 0 ? `$${payout.toFixed(2)}` : '—'} />
        <Row label="Return %" value={effShares > 0 ? `+${(ret * 100).toFixed(0)}%` : '—'} />
        {slippage != null && slippage > 0 && (
          <Row label="Slippage" value={`${(slippage * 100).toFixed(1)}%`} danger={slippage > WARN_SLIPPAGE} />
        )}
      </div>

      {limitInvalid && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          Enter a price between {fmtC(tickN)} and {fmtC(1 - tickN)}, in {tick} steps.
        </Etched>
      )}
      {noLiquidity && book.error === 'wallet_not_restored' && (
        <Etched size={11} weight={300} color="rgba(180,90,30,.85)">
          Couldn't confirm your wallet session for live pricing — reopen the popup or reconnect.
        </Etched>
      )}
      {noLiquidity && book.error !== 'wallet_not_restored' && (
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
          <Row label="Max payout" value={effShares > 0 ? `$${payout.toFixed(2)}` : '—'} />
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

      {/* The outcome of a real-money action, stated at a size you can read
          without leaning in. This used to be one line of 12px grey-green text
          reading "Order placed · 0x91a8322…" — indistinguishable from a
          caption, and the least legible thing on screen at the exact moment
          the user most needs certainty.

          Cancel deliberately does NOT live here: this is transient local
          state that resets when the component re-renders (switching tabs and
          back), so a cancel action tied to it could vanish while the order
          was still resting. "Your positions & open orders" below re-fetches
          real CLOB state on every mount and owns cancelling. */}
      {result && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            background: result.ok ? 'rgba(30,110,60,.10)' : 'rgba(160,40,40,.09)',
            border: `1px solid ${result.ok ? 'rgba(30,110,60,.45)' : 'rgba(160,40,40,.42)'}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <Etched size={14} weight={500} color={result.ok ? 'rgba(22,95,52,.98)' : 'rgba(150,32,32,.98)'}>
            {result.ok ? '✓ Order placed' : '✕ Order failed'}
          </Etched>
          <Etched size={12.5} weight={300} style={{ lineHeight: 1.45 }}>
            {result.msg}
          </Etched>
          {result.orderId && (
            <Etched size={11} weight={300} color="rgba(35,45,70,.6)">
              Order {shortRef(result.orderId)} · also saved to History
            </Etched>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <LinkAction onClick={() => setResult(null)}>Dismiss</LinkAction>
            {result.ok && onPortfolioChanged && (
              <LinkAction onClick={() => onPortfolioChanged()}>Refresh positions</LinkAction>
            )}
          </div>
        </div>
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
//
// `source` distinguishes a real scored match (from Check, on a live page)
// from a market picked directly from History: the latter was never run
// through the matcher, so there is no real confidence to report — printing
// a fabricated "100% confidence" for a manual pick would misrepresent it as
// a strong match rather than a deliberate user choice.
const MatchContext: React.FC<{
  headline?: string | null
  source: 'page' | 'history'
  confidence: number
  lowConfidence: boolean
  hasAlternatives: boolean
  onPickMatch: () => void
}> = ({ headline, source, confidence, lowConfidence, hasAlternatives, onPickMatch }) => {
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
            {source === 'history' ? 'From your history' : 'From this page'}
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
      {source === 'page' && (
        <Etched size={11} weight={300} color="rgba(35,45,70,.55)">
          Matched at {pct}% confidence{lowConfidence ? ' · low — double-check it fits' : ''}.
        </Etched>
      )}
      {hasAlternatives && (
        <div style={{ marginTop: 2 }}>
          <LinkAction onClick={onPickMatch}>Not this market? Choose on Check →</LinkAction>
        </div>
      )}
    </div>
  )
}

/**
 * One-line state of the user's own money, pinned to the top of the connected
 * Trade tab: how many positions, what they're worth, how many resolved
 * markets are waiting to be claimed, and whether any orders are still resting.
 * Everything here is already fetched for the panel below — this is purely
 * about it being visible without scrolling past a buy form.
 */
const PortfolioSummary: React.FC<{
  positions: Position[]
  openOrders: OpenOrderSummary[]
  loading: boolean
  onView: () => void
}> = ({ positions, openOrders, loading, onView }) => {
  const value = positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0)
  const pnl = positions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0)
  const redeemable = positions.filter((p) => p.redeemable).length
  const empty = positions.length === 0 && openOrders.length === 0

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 9,
        background: 'rgba(255,255,255,.07)',
        border: '1px solid rgba(255,255,255,.26)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <Etched size={11} weight={400} color="rgba(35,45,70,.6)" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Your portfolio
        </Etched>
        {!empty && <LinkAction onClick={onView}>View ↓</LinkAction>}
      </div>
      {loading && positions.length === 0 && openOrders.length === 0 ? (
        <Etched size={12} weight={300} color="rgba(35,45,70,.6)">Loading…</Etched>
      ) : empty ? (
        <Etched size={12} weight={300} color="rgba(35,45,70,.6)">
          No open positions yet — your trades will show up here.
        </Etched>
      ) : (
        <>
          <Etched size={13.5} weight={500}>
            {positions.length} position{positions.length === 1 ? '' : 's'} · ${value.toFixed(2)}
            <span style={{ color: pnl >= 0 ? 'rgba(30,110,60,.9)' : 'rgba(160,40,40,.9)', fontWeight: 400 }}>
              {' '}({pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})
            </span>
          </Etched>
          <Etched size={11} weight={300} color="rgba(35,45,70,.6)">
            {redeemable > 0 ? `${redeemable} resolved & claimable · ` : ''}
            {openOrders.length} resting order{openOrders.length === 1 ? '' : 's'}
          </Etched>
        </>
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

/**
 * Segmented-pill styling for the order-type and side toggles.
 *
 * BOTH branches must set background AND borderColor explicitly. The inactive
 * branch used to be `{}`, letting the pill fall through to `.glass-btn`'s own
 * rest style — which was pure white until de73548 re-tinted it cold blue.
 * From that commit on, the *unselected* pill was the one wearing the accent
 * colour while the "active" white overlay vanished into the light panel, so
 * the ticket showed BUY NO / Market as picked while it was really signing
 * BUY YES / Limit. A toggle whose selected state is defined only as "whatever
 * the base button isn't" inverts the moment the base button changes.
 */
export function sidePillStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        background: 'rgba(64,120,215,.34)',
        borderColor: 'rgba(64,120,215,.9)',
        color: 'rgba(12,30,70,.98)',
        fontWeight: 500,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.5), 0 1px 4px -1px rgba(20,60,140,.28)',
      }
    : {
        background: 'rgba(255,255,255,.05)',
        borderColor: 'rgba(35,45,70,.18)',
        color: 'rgba(35,45,70,.55)',
        boxShadow: 'none',
      }
}


/**
 * CLOB rejection reasons, now that submitSignedOrder actually forwards them
 * (it used to flatten every non-2xx into a bare `clob_rejected`). Matched on
 * substrings and case-insensitively because the exact wording comes from the
 * CLOB and has drifted between versions — an unmatched reason still falls
 * through to the raw text below, which is strictly better than the old
 * "clob_rejected".
 */
const CLOB_ERROR_HINTS: Array<[RegExp, string]> = [
  [/minimum (order )?size|min[_ ]size|order size.*(small|below)/i,
    "Order is below Polymarket's minimum size for this market — raise the amount."],
  [/not enough balance|insufficient (balance|funds)|allowance/i,
    'Not enough USDC in your Polymarket account (or the allowance is unset). Top up at polymarket.com, then retry.'],
  [/tick size|invalid price/i,
    "Price isn't a valid tick for this market — adjust it and retry."],
  [/not accepting orders|market not ready|market is closed|market closed/i,
    "This market isn't accepting orders right now."],
  [/fok order not filled|not filled/i,
    "Couldn't fill the whole order at your cap price — the book moved. Try a limit order."],
  [/clob_http_401|unauthorized|expired credentials|invalid api key/i,
    'Your Polymarket session expired — disconnect and reconnect the wallet.'],
  [/clob_http_429|rate limit/i, 'Polymarket is rate-limiting requests — wait a moment and retry.'],
]

function humanError(raw: string): string {
  if (raw.includes('signature_timeout')) {
    return "Your wallet never returned the signature. Open the wallet app, make sure there's no pending request waiting, and connect again."
  }
  if (raw.includes('wc_no_polygon_account')) {
    return 'Your wallet connected, but not on Polygon — Polymarket needs it. Switch the wallet to the Polygon network, then connect again.'
  }
  if (raw.includes('wc_method_not_granted')) {
    return "Your wallet connected but didn't grant permission to sign messages, so the account can't be verified. Reconnect and approve the full request — if your wallet lists permissions, allow signing."
  }
  for (const [pattern, message] of CLOB_ERROR_HINTS) {
    if (pattern.test(raw)) return message
  }
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
