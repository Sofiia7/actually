/**
 * Offscreen document — heavy-ops worker.
 *
 * Lives at chrome-extension://<id>/src/offscreen/offscreen.html, kept
 * alive by the Service Worker via chrome.offscreen API. Full Web API
 * (WASM, WSS, IndexedDB) is available here, unrestricted by news-site
 * CSP — which is critical for transformers.js and WalletConnect.
 *
 * All messages arriving at this document carry `target: 'offscreen'`
 * (the SW filters by that tag). Responses go back via sendResponse.
 */
import type { OffscreenRequest, OffscreenResponse, SerializableWalletState } from '../shared/messages'
import { getSettings } from '../background/settings'
import { isInAppRedeemAvailable } from '../background/builderStatus'
import { findMatch } from '@actually/core'
import { makeChromeMarketStore, makeSettingsEmbedder } from '../background/adapters'
import { refreshMarketCache, getMarketCache, getCacheStatus } from '../background/cache'
import { CACHE_TTL_MINUTES } from '../shared/constants'
import type { Settings } from '../shared/types'
import { fetchLivePrice } from '@actually/core'
import { addToHistory } from '../background/history'
import { trackEvent } from '../background/telemetry'
import { _resetGeoCache, getGeoStatus } from '../background/geo'
import {
  cancelOrder,
  connectWallet,
  disconnectWallet,
  getOpenOrders,
  getOrderbookSnapshot,
  placeOrder,
  restoreWallet,
  sellOrder,
  type WalletState,
} from '../background/trade'
import { resolveHistoryMarket } from '../background/resolveHistoryMarket'
import { redeemPosition } from '../background/redeem'
import { fetchPositions } from '../background/positions'
import { installStorageBridge } from './storage-bridge'
import { runningInOffscreenDocument } from './context'

/**
 * THIS GUARD IS LOAD-BEARING — see ./context.ts for the full explanation.
 *
 * Short version: this module registers a global chrome.runtime.onMessage
 * listener at import time, and the bundler also puts its chunk in the popup
 * page and the service worker. Since `routeToOffscreen` forwards by broadcast,
 * every context holding this listener handled every request — so every
 * offscreen operation ran once per context. The rejoin guard in
 * OS_START_CONNECT could never catch that: `sessions` and `currentConnectId`
 * are module-level, so each context had its own empty copy.
 */
const IS_OFFSCREEN_DOC = runningInOffscreenDocument()

// Some Chrome builds don't expose chrome.storage to offscreen documents. Install
// a proxy to the service worker BEFORE any handler touches storage (settings,
// cache, history). No-op when the native API is present.
if (IS_OFFSCREEN_DOC) {
  installStorageBridge()
}

// ============================================================
// Connect-session registry
// ------------------------------------------------------------
// `connectWallet` is multi-step (emits a URI partway, then resolves
// once the wallet approves). chrome.runtime messaging is one-shot
// request/response, so we expose two ops:
//   OS_START_CONNECT   → returns { sessionId } immediately
//   OS_POLL_CONNECT    → returns the current stage, with uri / wallet / error
// The widget polls every 500ms until stage === 'done' | 'error'.
// ============================================================
interface ConnectSession {
  stage: 'pending' | 'awaiting_approval' | 'signing' | 'done' | 'error'
  uri?: string
  wallet?: SerializableWalletState
  error?: string
}
const sessions = new Map<string, ConnectSession>()

/**
 * The connect the popup should be looking at, if it lost track of its own
 * sessionId.
 *
 * It loses it constantly: Chrome closes an extension popup on any focus loss,
 * including the user switching to their wallet app to approve — and the
 * sessionId lived only in the popup's component state. The connect itself
 * keeps running here, so without this the popup came back with no way to ask
 * about it, showed "Connect wallet" as if nothing had happened, and a second
 * click started a competing flow behind the first.
 */
let currentConnectId: string | null = null

function isInFlight(s: ConnectSession | undefined): boolean {
  return s?.stage === 'pending' || s?.stage === 'awaiting_approval' || s?.stage === 'signing'
}

// §12: lazy cache TTL. After a match is returned we kick off a non-blocking
// refresh if the cache is older than CACHE_TTL_MINUTES, deduped so concurrent
// matches don't stack refreshes. The user sees the current match immediately;
// fresh data lands on the next check.
let staleRefreshInFlight = false
// Shared in-flight guard for explicit OS_REFRESH_CACHE calls (auto-on-open +
// manual button), so concurrent requests await one refresh instead of stacking.
let refreshInFlight: Promise<{ added: number; reused: number; removed: number }> | null = null
async function maybeRefreshStale(settings: Settings): Promise<void> {
  if (staleRefreshInFlight) return
  const { lastUpdated } = await getCacheStatus()
  const ageMin = lastUpdated > 0 ? (Date.now() - lastUpdated) / 60_000 : Infinity
  if (ageMin <= CACHE_TTL_MINUTES) return
  staleRefreshInFlight = true
  void refreshMarketCache(settings.embeddingProvider, settings.workerUrl, settings.workerSecret)
    .catch(() => undefined)
    .finally(() => {
      staleRefreshInFlight = false
    })
}

function newSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function serializeWallet(w: WalletState): SerializableWalletState {
  return {
    topic: w.topic,
    address: w.address,
    safeAddress: w.safeAddress,
    creds: { key: w.creds.key, secret: w.creds.secret, passphrase: w.creds.passphrase },
  }
}

async function rehydrateWallet(): Promise<WalletState | null> {
  // The wallet state lives in chrome.storage and is reconstructed by
  // restoreWallet(); we reuse that path so the SDK gets the exact same
  // shape it expects.
  return restoreWallet()
}

// ============================================================
// Message router
// ============================================================
interface ForwardEnvelope {
  __forward: true
  payload: OffscreenRequest
}

// See IS_OFFSCREEN_DOC above — registering this anywhere else makes every
// offscreen operation run twice.
if (IS_OFFSCREEN_DOC) {
  chrome.runtime.onMessage.addListener((env: unknown, _sender, sendResponse) => {
    const e = env as ForwardEnvelope | null
    if (!e || e.__forward !== true) return false
    const msg = e.payload
    if (!msg || (msg as { target?: string }).target !== 'offscreen') return false
    void handle(msg).then(sendResponse).catch((err) => {
      sendResponse({ type: 'OS_ERROR', error: String(err) } satisfies OffscreenResponse)
    })
    return true // async
  })
}

async function handle(msg: OffscreenRequest): Promise<OffscreenResponse> {
  switch (msg.type) {
    case 'OS_PING':
      return { type: 'OS_PONG' }

    case 'OS_RUN_MATCH': {
      // Step tracker — surfaces which line threw if anything blows up,
      // so users without DevTools can still report a useful error.
      let step = 'init'
      try {
        step = 'chrome_check'
        if (typeof chrome === 'undefined' || !chrome.storage) {
          return { type: 'OS_MATCH_RESULT', match: null, reason: 'no_chrome_api' }
        }
        step = 'get_settings'
        const settings = await getSettings()
        if (!settings.workerUrl || !settings.workerSecret) {
          return { type: 'OS_MATCH_RESULT', match: null, reason: 'no_keys' }
        }
        void trackEvent('check_page_clicked', settings)
        step = 'get_cache'
        let cacheNow = await getMarketCache()
        const cacheHadEmbeddings = cacheNow.some((m) => !!m.embeddingB64)
        if (cacheNow.length === 0 || !cacheHadEmbeddings) {
          try {
            step = 'refresh_cache'
            await refreshMarketCache(settings.embeddingProvider, settings.workerUrl, settings.workerSecret)
          } catch (err) {
            return { type: 'OS_MATCH_RESULT', match: null, reason: `cache_refresh_failed:${String(err)}` }
          }
          step = 'get_cache_after_refresh'
          cacheNow = await getMarketCache()
        }
        step = 'find_match'
        const match = await findMatch(msg.article.headline, msg.article.bodyText, {
          store: makeChromeMarketStore(),
          embedder: makeSettingsEmbedder(settings),
          thresholds: {
            confidenceThreshold: settings.confidenceThreshold,
            lowConfidenceFloor: settings.lowConfidenceFloor,
          },
        })
        if (!match) {
          // Surface diagnostics in the reason so the UI can show what
          // actually happened (cache size, why nothing matched). Without
          // this it's impossible to debug without devtools.
          const embedded = cacheNow.filter((m) => !!m.embeddingB64).length
          void trackEvent('no_match', settings, { reason: 'below_floor' })
          return {
            type: 'OS_MATCH_RESULT',
            match: null,
            reason: `below_floor:cache=${cacheNow.length}/embedded=${embedded}/floor=${settings.lowConfidenceFloor}`,
          }
        }
        // Live price refresh (non-fatal). Use the YES token explicitly —
        // Polymarket does not guarantee outcomes[0] is "Yes" (some markets
        // list "No" first), and clobTokenIds is parallel to outcomes. Hitting
        // [0] blindly can fetch and display the NO price as if it were YES.
        const { findOutcomeIndex } = await import('@actually/core')
        const yesIdx = findOutcomeIndex(match.market.outcomes, 'Yes')
        const tokenId = match.market.clobTokenIds[yesIdx]
        if (tokenId) {
          try {
            const live = await fetchLivePrice(tokenId, settings.workerUrl, settings.workerSecret)
            if (live !== null) match.freshPrice = live
          } catch { /* ignore */ }
        }
        await addToHistory(match, msg.article.url)
        void trackEvent(match.lowConfidence ? 'match_lowconf' : 'match_shown', settings, {
          color: match.color,
          confidence_bucket: Math.floor(match.confidence * 10) / 10,
        })
        void maybeRefreshStale(settings) // §12 non-blocking TTL refresh
        return { type: 'OS_MATCH_RESULT', match }
      } catch (err) {
        return { type: 'OS_MATCH_RESULT', match: null, reason: `match_error[step=${step}]:${String(err)}` }
      }
    }

    case 'OS_REFRESH_CACHE': {
      const settings = await getSettings()
      if (!settings.workerUrl || !settings.workerSecret) {
        throw new Error('no_keys')
      }
      // Dedupe concurrent refreshes (auto-on-open + manual "Refresh" + the
      // match-triggered stale refresh) so the embed loop never runs in parallel.
      if (!refreshInFlight) {
        refreshInFlight = refreshMarketCache(
          settings.embeddingProvider,
          settings.workerUrl,
          settings.workerSecret,
        ).finally(() => {
          refreshInFlight = null
        })
      }
      const r = await refreshInFlight
      return { type: 'OS_CACHE_REFRESHED', ...r }
    }

    case 'OS_BUILDER_STATUS': {
      return { type: 'OS_BUILDER_STATUS_RESULT', available: await isInAppRedeemAvailable() }
    }

    case 'OS_GET_GEO': {
      const settings = await getSettings()
      _resetGeoCache() // honor the offscreen session, not the popup-cached one
      const g = await getGeoStatus(settings.workerUrl, settings.workerSecret)
      return {
        type: 'OS_GEO_RESULT',
        country: g.country,
        blocked: g.blocked,
        unknown: g.unknown,
        errorReason: g.errorReason,
      }
    }

    case 'OS_RESTORE_WALLET': {
      const w = await rehydrateWallet()
      return { type: 'OS_WALLET_RESTORED', wallet: w ? serializeWallet(w) : null }
    }

    case 'OS_DISCONNECT_WALLET': {
      // Best-effort session lookup — if the WC client can't even initialize
      // (relay unreachable, offline, corrupted WC storage), `w` stays null
      // but disconnectWallet() below still runs and wipes local storage.
      // Without this guard, a rehydrateWallet() throw would propagate out of
      // this handler entirely and the wipe the user asked for would never
      // happen — see disconnectWallet's doc comment in trade.ts.
      let w: WalletState | null = null
      try {
        w = await rehydrateWallet()
      } catch {
        // fall through to the unconditional wipe below
      }
      await disconnectWallet(w)
      return { type: 'OS_WALLET_RESTORED', wallet: null }
    }

    case 'OS_START_CONNECT': {
      // Rejoin an in-flight connect rather than racing a second one against
      // it. Two live flows means two QR codes, two pairings, and a wallet
      // prompt that belongs to whichever one the user isn't looking at.
      if (currentConnectId && isInFlight(sessions.get(currentConnectId))) {
        return { type: 'OS_CONNECT_STARTED', sessionId: currentConnectId }
      }
      const sessionId = newSessionId()
      sessions.clear() // at most one record is ever worth keeping
      sessions.set(sessionId, { stage: 'pending' })
      currentConnectId = sessionId
      // Run the connect flow in the background; updates the session
      // record as URI / stage / wallet / error become known.
      void (async () => {
        try {
          const result = await connectWallet({
            onUri: (uri) => sessions.set(sessionId, { stage: 'awaiting_approval', uri }),
            onStage: (stage) => {
              const prev = sessions.get(sessionId)
              sessions.set(sessionId, { ...prev, stage })
            },
          })
          sessions.set(sessionId, {
            stage: 'done',
            wallet: serializeWallet(result),
          })
        } catch (err) {
          sessions.set(sessionId, { stage: 'error', error: String(err) })
        }
      })()
      return { type: 'OS_CONNECT_STARTED', sessionId }
    }

    case 'OS_POLL_CONNECT': {
      const id = msg.sessionId ?? currentConnectId
      const s = id ? sessions.get(id) : undefined
      if (!s) return { type: 'OS_CONNECT_STATUS', stage: 'error', error: 'unknown_session' }
      // Deliberately NOT deleted on read. The popup can be closed and
      // reopened at any point (Chrome does it on focus loss), and a record
      // dropped on the first read of a final state left the next popup with
      // no way to learn that the connect it started had already succeeded.
      // A finished record is superseded by the next OS_START_CONNECT instead.
      return {
        type: 'OS_CONNECT_STATUS',
        stage: s.stage,
        uri: s.uri,
        wallet: s.wallet,
        error: s.error,
      }
    }

    case 'OS_PLACE_ORDER': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_ORDER_RESULT', ok: false, error: 'no_wallet' }
      const r = await placeOrder({
        state: w,
        tokenId: msg.args.tokenId,
        side: msg.args.side,
        sizeUsd: msg.args.sizeUsd,
        price: msg.args.price,
        negRisk: msg.args.negRisk,
        tickSize: msg.args.tickSize,
        minOrderSize: msg.args.minOrderSize,
        orderType: msg.args.orderType,
        makerTaker: msg.args.makerTaker,
      })
      return { type: 'OS_ORDER_RESULT', ...r }
    }

    case 'OS_SELL_ORDER': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_ORDER_RESULT', ok: false, error: 'no_wallet' }
      const r = await sellOrder({
        state: w,
        tokenId: msg.args.tokenId,
        sizeShares: msg.args.sizeShares,
        price: msg.args.price,
        negRisk: msg.args.negRisk,
        tickSize: msg.args.tickSize,
        minOrderSize: msg.args.minOrderSize,
        orderType: msg.args.orderType,
      })
      return { type: 'OS_ORDER_RESULT', ...r }
    }

    case 'OS_REDEEM_POSITION': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_REDEEM_RESULT', ok: false, error: 'no_wallet' }
      const settings = await getSettings()
      if (!settings.workerUrl || !settings.workerSecret) {
        return { type: 'OS_REDEEM_RESULT', ok: false, error: 'worker_not_configured' }
      }
      // Positions are re-fetched here rather than trusted from the popup: the
      // redeem amount for a neg-risk market comes straight off the held size,
      // and a stale number from a popup that has been open a while would
      // encode the wrong amount into an on-chain call.
      let positions
      try {
        positions = await fetchPositions(w.safeAddress, settings.workerUrl, settings.workerSecret)
      } catch (err) {
        return { type: 'OS_REDEEM_RESULT', ok: false, error: `positions_unavailable:${err}` }
      }
      const r = await redeemPosition({
        topic: w.topic,
        address: w.address,
        conditionId: msg.conditionId,
        positions,
      })
      return { type: 'OS_REDEEM_RESULT', ...r }
    }

    case 'OS_CANCEL_ORDER': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_ORDER_RESULT', ok: false, error: 'no_wallet' }
      const r = await cancelOrder(w, msg.orderId)
      return { type: 'OS_ORDER_RESULT', ...r }
    }

    case 'OS_GET_OPEN_ORDERS': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_OPEN_ORDERS_RESULT', ok: false, error: 'no_wallet' }
      const r = await getOpenOrders(w, msg.marketId)
      return { type: 'OS_OPEN_ORDERS_RESULT', ...r }
    }

    case 'OS_GET_POSITIONS': {
      const w = await rehydrateWallet()
      if (!w) return { type: 'OS_POSITIONS_RESULT', ok: false, error: 'no_wallet' }
      const settings = await getSettings()
      if (!settings.workerUrl || !settings.workerSecret) {
        return { type: 'OS_POSITIONS_RESULT', ok: false, error: 'not_configured' }
      }
      try {
        const positions = await fetchPositions(w.safeAddress, settings.workerUrl, settings.workerSecret)
        return { type: 'OS_POSITIONS_RESULT', ok: true, positions }
      } catch (err) {
        return { type: 'OS_POSITIONS_RESULT', ok: false, error: String(err) }
      }
    }

    case 'OS_RESOLVE_HISTORY_MARKET': {
      const settings = await getSettings()
      if (!settings.workerUrl || !settings.workerSecret) {
        return { type: 'OS_HISTORY_MARKET_RESOLVED', market: null, error: 'not_found' }
      }
      const r = await resolveHistoryMarket(msg.marketId, settings.workerUrl, settings.workerSecret)
      return r.ok
        ? { type: 'OS_HISTORY_MARKET_RESOLVED', market: r.market }
        : { type: 'OS_HISTORY_MARKET_RESOLVED', market: null, error: r.error }
    }

    case 'OS_PRICE_HISTORY': {
      const settings = await getSettings()
      if (!settings.workerUrl || !settings.workerSecret) {
        return { type: 'OS_PRICE_HISTORY', points: [] }
      }
      // CLOB prices-history takes an explicit window (startTs/endTs, unix
      // seconds) + `fidelity` (bucket minutes). Do NOT also pass `interval`
      // — that's a relative range and conflicts with an explicit window.
      const nowSec = Math.floor(Date.now() / 1000)
      const params = new URLSearchParams({
        market: msg.marketIdOrTokenId,
        startTs: String(nowSec - (msg.days ?? 7) * 86400),
        endTs: String(nowSec),
        fidelity: '60',
      })
      try {
        const res = await fetch(`${settings.workerUrl}/history?${params}`, {
          headers: { 'X-Actually-Auth': settings.workerSecret },
        })
        if (!res.ok) return { type: 'OS_PRICE_HISTORY', points: [] }
        const data = (await res.json()) as { history?: Array<{ t: number; p: number }> }
        return { type: 'OS_PRICE_HISTORY', points: data.history ?? [] }
      } catch {
        return { type: 'OS_PRICE_HISTORY', points: [] }
      }
    }

    case 'OS_ORDERBOOK_SNAPSHOT': {
      const w = await rehydrateWallet()
      // Distinct from a genuinely empty book (see OrderbookSnapshot's own
      // shape below) — an OS_ERROR here lets the UI tell "we couldn't
      // confirm your wallet session for this lookup" apart from "this
      // market really has no resting asks right now". Returning a
      // same-shaped-but-null book for both (the old behavior) made a
      // transient wallet-restore hiccup indistinguishable from real
      // illiquidity — see restoreWallet()'s doc comment in trade.ts.
      if (!w) return { type: 'OS_ERROR', error: 'wallet_not_restored' }
      const snap = await getOrderbookSnapshot(w, msg.tokenId)
      // Walk the book for a depth-based fill estimate when the UI passes the
      // intended size (shares); otherwise just return the top-of-book.
      const estimate = msg.sizeShares != null ? snap.estimateBuy(msg.sizeShares) : null
      return {
        type: 'OS_ORDERBOOK',
        bestBid: snap.bestBid,
        bestAsk: snap.bestAsk,
        spread: snap.spread,
        bids: snap.bids,
        asks: snap.asks,
        estimate,
      }
    }

    default: {
      const _exhaustive: never = msg
      void _exhaustive
      return { type: 'OS_ERROR', error: 'unknown_offscreen_op' }
    }
  }
}
