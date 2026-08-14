/**
 * Trade module — orchestrates the popup's order placement flow.
 *
 * Composition:
 *   ./wallet.ts   — WCSigner backed by WalletConnect v2 session
 *   ./clob.ts     — ClobClient (with builderCode), createOrDeriveApiKey,
 *                   signBuyOrder + submitSignedOrder, pollOrderStatus
 *   ./geo.ts      — country gate
 *
 * Persisted state in chrome.storage.local (managed via settings.ts):
 *   wcSessionTopic, walletAddress, safeAddress,
 *   clobApiKey, clobApiSecret, clobApiPassphrase
 *
 * The popup imports `placeOrder` and `connectWallet` directly; the SW
 * delegates `PLACE_ORDER` back to the popup since CLOB+WC can't run in a
 * service worker.
 */
import { OrderType, type ApiKeyCreds } from '@polymarket/clob-client-v2'
import { deriveSafeAddress, isBelowMinOrderSize, minOrderShares, orderShares } from '@actually/core'
import { BUILDER_CODE, GEO_FAIL_OPEN, MAX_ORDER_USD } from '../shared/constants'
import {
  cancelOrder as clobCancelOrder,
  deriveCredentials,
  fetchOrderBook,
  listOpenOrders,
  makeClient,
  pollOrderStatus,
  signBuyOrder,
  signMarketBuyOrder,
  submitSignedOrder,
} from './clob'
import type { OpenOrderSummary, Settings } from '../shared/types'
import {
  type ActiveSession,
  WCSigner,
  disconnect as wcDisconnect,
  resetSignClient,
  pruneOtherSessions,
  restoreSession,
  startConnect,
} from './wallet'
import { getGeoStatus } from './geo'
import { getSettings, saveSettings } from './settings'
import { trackEvent } from './telemetry'

export interface WalletState {
  topic: string
  address: string
  safeAddress: string
  creds: ApiKeyCreds
}

export interface ConnectCallbacks {
  onUri: (uri: string) => void
  onApproved?: (session: ActiveSession) => void
  /** Progress for the UI. `signing` means the QR was approved and we are now
   * waiting on the SECOND wallet prompt (the CLOB-auth signature). */
  onStage?: (stage: 'signing') => void
}

/**
 * How long to wait for the CLOB-auth signature before giving up.
 *
 * This request goes out over the WalletConnect session as a separate prompt
 * from the QR approval — a second thing to approve, raised by the wallet app
 * on its own schedule, and easy to miss if the wallet is in the background.
 * `client.request` has no timeout of its own, so an unapproved prompt used to
 * park the whole connect forever with the popup still showing the QR screen
 * and nothing to indicate what it was waiting for.
 */
const SIGNATURE_TIMEOUT_MS = 180_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ])
}

/**
 * Credentials already stored for `address`, or null.
 *
 * CLOB API credentials are derived deterministically from a signature by the
 * address that owns them, so the ones on disk stay valid for that address
 * across any number of WalletConnect sessions. Reconnecting the same wallet
 * therefore does not need a fresh derivation — and skipping it removes a
 * whole wallet-signature prompt from the reconnect flow.
 */
function reusableCreds(
  settings: Pick<Settings, 'walletAddress' | 'clobApiKey' | 'clobApiSecret' | 'clobApiPassphrase'>,
  address: string,
): ApiKeyCreds | null {
  if (!settings.walletAddress || settings.walletAddress.toLowerCase() !== address.toLowerCase()) {
    return null
  }
  const { clobApiKey, clobApiSecret, clobApiPassphrase } = settings
  if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) return null
  return { key: clobApiKey, secret: clobApiSecret, passphrase: clobApiPassphrase }
}

/**
 * Full connect flow: WC session → funder lookup → API-key derive → persist.
 * Returns a fully usable WalletState. Throws on any step the user can't
 * recover from inside the popup.
 */
export async function connectWallet(cb: ConnectCallbacks): Promise<WalletState> {
  const settings = await getSettings()
  if (!settings.workerUrl || !settings.workerSecret) {
    throw new Error('worker_not_configured')
  }
  if (!BUILDER_CODE) {
    throw new Error('builder_code_not_configured')
  }

  // 1. Geo gate before showing any wallet UI.
  // - confirmed restricted → throw
  // - unknown (Worker misconfig / network) → proceed; Polymarket itself
  //   blocks restricted regions at order time, and the UI shows an inline
  //   warning so the user knows the safety net isn't engaged.
  const geo = await getGeoStatus(settings.workerUrl, settings.workerSecret)
  if (!geo.unknown && geo.blocked) {
    void trackEvent('geo_blocked', settings, { country: geo.country })
    throw new Error('geo_blocked')
  }
  // Unknown geo: behavior depends on GEO_FAIL_OPEN (see constants.ts).
  // fail-open → proceed with a UI warning (Polymarket blocks at order time);
  // fail-closed (prod default) → pause connect until the region is confirmed.
  if (geo.unknown) {
    void trackEvent('geo_unknown', settings, { stage: 'connect', reason: geo.errorReason ?? 'unknown' })
    if (!GEO_FAIL_OPEN) throw new Error('geo_unavailable')
  }

  void trackEvent('wallet_connect_started', settings)

  // 2. Start WC session — caller renders the QR / deeplink
  let session: ActiveSession
  try {
    const { uri, approval } = await startConnect()
    cb.onUri(uri)
    session = await approval
    cb.onApproved?.(session)
  } catch (err) {
    void trackEvent('wallet_connect_failed', settings, { stage: 'wc_approval' })
    throw err
  }

  // 3. Resolve user's Polymarket Safe (funder)
  const safeAddress = deriveSafeAddress(session.address)

  // 4. CLOB API credentials. Reuse the ones already stored for this exact
  //    address instead of re-deriving: derivation costs a wallet signature,
  //    and the credentials are a pure function of the address, so a
  //    reconnect of the same wallet does not need a new one. Only a
  //    different address (or nothing stored yet) pays that prompt.
  const signer = new WCSigner(session.topic, session.address)
  const client = makeClient({ signer, funderAddress: safeAddress })
  let creds = reusableCreds(settings, session.address)
  if (!creds) {
    // Tell the UI before blocking on it — this is the step where the wallet
    // raises its second prompt, and the user has to go back to the wallet app
    // to approve it. Silence here read as "the connect did nothing".
    cb.onStage?.('signing')
    creds = await withTimeout(
      deriveCredentials(client),
      SIGNATURE_TIMEOUT_MS,
      'signature_timeout',
    )
  }

  // 5. Persist everything for next popup open
  await saveSettings({
    wcSessionTopic: session.topic,
    walletAddress: session.address,
    safeAddress,
    clobApiKey: creds.key,
    clobApiSecret: creds.secret,
    clobApiPassphrase: creds.passphrase,
  })

  // 6. Only now drop the sessions this connect superseded — AFTER the new one
  //    is on disk, and without awaiting it. Tearing down a stale session is a
  //    relay round-trip to a peer that is, by definition, probably gone, so it
  //    can stall for a long time or never answer at all. Doing it before the
  //    save (as this briefly did) put every one of those round-trips between
  //    the user's signature and the moment the wallet became usable: the
  //    connect appeared to hang forever, and reopening the popup found nothing
  //    stored. Pruning is housekeeping — it must never gate the connect.
  void pruneOtherSessions(session.topic)

  void trackEvent('wallet_connect_success', settings)
  return { topic: session.topic, address: session.address, safeAddress, creds }
}

/**
 * Restore a previously connected wallet on popup open. Returns null if no
 * session is stored, restoreSession() couldn't confirm one right now, or
 * the WC relay reports a different session in its place.
 *
 * Called far more often than "on popup open" alone — every offscreen op
 * that needs a signer (orderbook snapshot, place/cancel order, positions)
 * independently re-derives its own WalletState via this same function
 * (see offscreen.ts's rehydrateWallet()), rather than trusting a cached
 * reference. That makes restoreSession()'s reliability load-bearing far
 * more often than it looks from call sites alone — including calls that
 * fire moments after the offscreen document itself was just recreated
 * (MV3 can evict it during any idle stretch, e.g. the user reading an
 * article before returning to trade), when the WalletConnect SignClient's
 * own session store may not have finished hydrating from IndexedDB yet.
 */
export async function restoreWallet(): Promise<WalletState | null> {
  const s = await getSettings()
  if (
    !s.wcSessionTopic ||
    !s.walletAddress ||
    !s.safeAddress ||
    !s.clobApiKey ||
    !s.clobApiSecret ||
    !s.clobApiPassphrase
  ) {
    return null
  }
  // Ask for OUR topic by name rather than "whichever session looks newest".
  const session = await restoreSession(s.wcSessionTopic)
  if (!session || session.topic !== s.wcSessionTopic) {
    // Either no session came back at all, or ours specifically isn't in the
    // store right now.
    //
    // NEITHER wipes storage. A fresh SignClient (right after the offscreen
    // document was recreated — MV3 evicts it during any idle stretch, e.g.
    // while the user reads the article) can report zero sessions, or a
    // partially-hydrated subset, for a moment before its own IndexedDB store
    // finishes loading. Treating that as "you connected a different wallet"
    // and clearing the API credentials is what turned an ordinary popup
    // reopen into "connect again, scan again, sign again" — and because the
    // reconnect left the old session live too, the next lookup was even more
    // ambiguous than the last. Report "not restorable right now" and let the
    // next call succeed; the only thing that clears credentials is the user
    // pressing Disconnect, or a completed connect overwriting them.
    return null
  }
  if (session.address.toLowerCase() !== s.walletAddress.toLowerCase()) {
    // Same topic, different account selected in the wallet. The stored CLOB
    // credentials belong to the old address and must not be used to sign for
    // the new one — but they're still valid for their own address, so this
    // reports "reconnect needed" without destroying them either.
    return null
  }
  return {
    topic: session.topic,
    address: session.address,
    safeAddress: s.safeAddress,
    creds: {
      key: s.clobApiKey,
      secret: s.clobApiSecret,
      passphrase: s.clobApiPassphrase,
    },
  }
}

/**
 * WalletConnect v2's own persistence — see wallet.ts's `resetSignClient` doc
 * comment. Deleting it removes pairings, the keychain, and the JSON-RPC
 * history (which includes every order's signed typed-data payload and the
 * connected address) that `chrome.storage.local` never touched. Best-effort:
 * a wipe the user explicitly asked for must not fail loudly over this.
 */
async function wipeWalletConnectStorage(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('WALLET_CONNECT_V2_INDEXED_DB')
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })
  } catch {
    // Best-effort — see comment above.
  }
}

export async function disconnectWallet(state: WalletState | null): Promise<void> {
  // Clear local storage FIRST and unconditionally. This is the part the
  // user actually asked for ("wipe") — the WC-side teardown below is
  // already best-effort (wcDisconnect never throws) and must never delay or
  // gate this, so a relay outage or a corrupted WC session can't leave
  // credentials behind.
  await saveSettings({
    wcSessionTopic: undefined,
    walletAddress: undefined,
    safeAddress: undefined,
    clobApiKey: undefined,
    clobApiSecret: undefined,
    clobApiPassphrase: undefined,
  })
  // wcDisconnect (wallet.ts) already catches its own failures internally,
  // but this call is wrapped again here too: the storage wipe above must
  // never depend on that invariant holding across future changes to
  // wallet.ts — belt and suspenders for a real-money credential wipe.
  if (state) {
    try {
      await wcDisconnect(state.topic)
    } catch {
      // Best-effort — see comment above.
    }
  }
  await wipeWalletConnectStorage()
  resetSignClient()
}

export interface PlaceOrderArgs {
  state: WalletState
  tokenId: string
  /** YES → buy YES token. NO → buy NO token (caller passes the right tokenId). */
  side: 'BUY_YES' | 'BUY_NO'
  /** USDC notional from the UI (e.g. $20) */
  sizeUsd: number
  /** LIMIT → resting limit price; MARKET → worst-acceptable cap price (0..1). */
  price: number
  negRisk: boolean
  /** Exact tick size from the matched market; falls back to negRisk default. */
  tickSize?: string
  /** Market's minimum order size in shares; falls back to the platform default. */
  minOrderSize?: number
  /** LIMIT → GTC resting order; MARKET → FOK capped at `price`. */
  orderType: 'LIMIT' | 'MARKET'
  /** UI-derived maker/taker classification — telemetry only. */
  makerTaker?: 'maker' | 'taker'
}

export interface OrderSubmitResult {
  ok: boolean
  orderId?: string
  error?: string
}

export async function placeOrder(args: PlaceOrderArgs): Promise<OrderSubmitResult> {
  // Enforced here (not just the UI's `max` attribute/disabled state) — see
  // MAX_ORDER_USD's doc comment. Checked before any network call so a
  // fat-fingered amount fails immediately, not after a geo lookup.
  if (args.sizeUsd > MAX_ORDER_USD) {
    return { ok: false, error: `order_exceeds_max_usd:${MAX_ORDER_USD}` }
  }
  // The mirror of the cap: CLOB refuses anything under the market's minimum
  // order size, and that floor is on SHARES, so it moves with price. The UI
  // blocks this too, but only this path is guaranteed to run before we ask
  // the user for a signature they'd otherwise spend on a doomed order.
  if (isBelowMinOrderSize(args.sizeUsd, args.price, args.minOrderSize)) {
    return { ok: false, error: `order_below_min_size:${minOrderShares(args.minOrderSize)}` }
  }
  const settings = await getSettings()
  if (!settings.workerUrl || !settings.workerSecret) {
    return { ok: false, error: 'worker_not_configured' }
  }
  // Same posture as connectWallet: only hard-block on confirmed restricted.
  const geo = await getGeoStatus(settings.workerUrl, settings.workerSecret)
  if (!geo.unknown && geo.blocked) {
    void trackEvent('geo_blocked', settings, { country: geo.country, stage: 'submit' })
    return { ok: false, error: 'geo_blocked' }
  }
  // Unknown geo: same posture as connect. Defense-in-depth — the UI also
  // gates this, but the submit path enforces independently.
  if (geo.unknown) {
    void trackEvent('geo_unknown', settings, { stage: 'submit', reason: geo.errorReason ?? 'unknown' })
    if (!GEO_FAIL_OPEN) return { ok: false, error: 'geo_unavailable' }
  }

  const signer = new WCSigner(args.state.topic, args.state.address)
  const client = makeClient({
    signer,
    funderAddress: args.state.safeAddress,
    creds: args.state.creds,
  })

  const isMarket = args.orderType === 'MARKET'

  // 1. Ask the wallet to sign the typed-data order. If the user rejects in
  //    MetaMask / WC, we do NOT count it as `order_signed`.
  //    LIMIT  → resting GTC order at `price` for the share-converted size.
  //    MARKET → FOK for `sizeUsd` notional, capped at `price`.
  let signed: unknown
  try {
    if (isMarket) {
      signed = await signMarketBuyOrder(client, {
        tokenId: args.tokenId,
        sizeUsd: args.sizeUsd,
        capPrice: args.price,
        negRisk: args.negRisk,
        tickSize: args.tickSize,
      })
    } else {
      // Convert USD notional → shares the user receives if filled at `price`.
      // Shared with the minimum-size guard above so the two can't drift.
      const size = orderShares(args.sizeUsd, args.price)
      signed = await signBuyOrder(client, {
        tokenId: args.tokenId,
        price: args.price,
        size,
        negRisk: args.negRisk,
        tickSize: args.tickSize,
      })
    }
  } catch (err) {
    void trackEvent('order_failed', settings, {
      side: args.side,
      stage: 'sign',
      reason: String(err),
    })
    return { ok: false, error: `sign_failed:${err}` }
  }
  void trackEvent('order_signed', settings, {
    side: args.side,
    size_bucket: sizeBucket(args.sizeUsd),
    order_type: args.orderType,
  })

  // 2. Post the signed payload to CLOB with the matching execution type.
  const result = await submitSignedOrder(
    client,
    signed,
    isMarket ? OrderType.FOK : OrderType.GTC,
  )
  if (!result.success) {
    void trackEvent('order_failed', settings, {
      side: args.side,
      stage: 'submit',
      reason: result.error ?? 'unknown',
    })
    return { ok: false, error: result.error ?? 'unknown_error' }
  }
  void trackEvent('order_submitted', settings, {
    side: args.side,
    size_bucket: sizeBucket(args.sizeUsd),
    order_type: args.orderType,
    ...(args.makerTaker ? { maker_taker: args.makerTaker } : {}),
  })

  // 3. Fire-and-forget poll for fill status. UI returns from this call
  //    immediately on submit-success — the fill event is a downstream
  //    KPI signal, not part of the synchronous order flow.
  if (result.orderId) {
    void (async () => {
      const status = await pollOrderStatus(client, result.orderId!)
      if (status === 'matched') {
        void trackEvent('order_filled', settings, { side: args.side })
      }
    })()
  }

  return { ok: true, orderId: result.orderId }
}

/**
 * Cancel a previously-placed resting order. No geo gate — cancelling only
 * ever reduces risk, never places new exposure.
 */
export async function cancelOrder(
  state: WalletState,
  orderId: string,
): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings()
  const signer = new WCSigner(state.topic, state.address)
  const client = makeClient({
    signer,
    funderAddress: state.safeAddress,
    creds: state.creds,
  })
  const result = await clobCancelOrder(client, orderId)
  if (!result.success) {
    void trackEvent('order_cancel_failed', settings, { reason: result.error ?? 'unknown' })
    return { ok: false, error: result.error ?? 'unknown_error' }
  }
  void trackEvent('order_cancelled', settings)
  return { ok: true }
}

/** List the connected wallet's resting orders, optionally filtered to one market. */
export async function getOpenOrders(
  state: WalletState,
  marketId?: string,
): Promise<{ ok: boolean; orders?: OpenOrderSummary[]; error?: string }> {
  try {
    const signer = new WCSigner(state.topic, state.address)
    const client = makeClient({ signer, funderAddress: state.safeAddress, creds: state.creds })
    const orders = await listOpenOrders(client, marketId)
    return { ok: true, orders }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

function sizeBucket(usd: number): string {
  if (usd < 10) return 'lt_10'
  if (usd < 50) return '10_50'
  if (usd < 200) return '50_200'
  if (usd < 1000) return '200_1k'
  return 'gt_1k'
}

export interface OrderbookLevel {
  price: number
  size: number
}

/** How many levels of depth to surface past best bid/ask — enough for a glance, not a full ladder. */
const DEPTH_LEVELS = 5

export interface OrderbookSnapshot {
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  /** Top DEPTH_LEVELS bids, best (highest) first. */
  bids: OrderbookLevel[]
  /** Top DEPTH_LEVELS asks, best (lowest) first. */
  asks: OrderbookLevel[]
  /** Estimated effective price for a market buy of `sizeShares`. */
  estimateBuy: (sizeShares: number) => { effectivePrice: number; slippage: number } | null
}

export async function getOrderbookSnapshot(
  state: WalletState,
  tokenId: string,
): Promise<OrderbookSnapshot> {
  const signer = new WCSigner(state.topic, state.address)
  const client = makeClient({
    signer,
    funderAddress: state.safeAddress,
    creds: state.creds,
  })
  const book = await fetchOrderBook(client, tokenId)

  const asks = book.asks?.map((l) => ({ price: Number(l.price), size: Number(l.size) })) ?? []
  const bids = book.bids?.map((l) => ({ price: Number(l.price), size: Number(l.size) })) ?? []
  asks.sort((a, b) => a.price - b.price)
  bids.sort((a, b) => b.price - a.price)

  const bestAsk = asks[0]?.price ?? null
  const bestBid = bids[0]?.price ?? null
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null

  return {
    bestBid,
    bestAsk,
    spread,
    bids: bids.slice(0, DEPTH_LEVELS),
    asks: asks.slice(0, DEPTH_LEVELS),
    estimateBuy: (sizeShares) => {
      if (asks.length === 0 || bestAsk == null) return null
      let remaining = sizeShares
      let cost = 0
      for (const lvl of asks) {
        const take = Math.min(remaining, lvl.size)
        cost += take * lvl.price
        remaining -= take
        if (remaining <= 0) break
      }
      if (remaining > 0) {
        // Not enough depth — flag with worst-ask + 100% slippage so the UI
        // can warn loudly. Use the deepest available level (last ask), or
        // bestAsk as a safety fallback if asks somehow became empty mid-walk.
        const worstAsk = asks[asks.length - 1]?.price ?? bestAsk
        return { effectivePrice: worstAsk, slippage: 1 }
      }
      const eff = cost / sizeShares
      const slip = (eff - bestAsk) / bestAsk
      return { effectivePrice: eff, slippage: slip }
    },
  }
}
