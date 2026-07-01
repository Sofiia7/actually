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
import { deriveSafeAddress } from '@actually/core'
import { BUILDER_CODE, GEO_FAIL_OPEN } from '../shared/constants'
import {
  deriveCredentials,
  fetchOrderBook,
  makeClient,
  pollOrderStatus,
  signBuyOrder,
  signMarketBuyOrder,
  submitSignedOrder,
} from './clob'
import {
  type ActiveSession,
  WCSigner,
  disconnect as wcDisconnect,
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

  // 4. Derive CLOB API credentials (one-time signature)
  const signer = new WCSigner(session.topic, session.address)
  const client = makeClient({ signer, funderAddress: safeAddress })
  const creds = await deriveCredentials(client)

  // 5. Persist everything for next popup open
  await saveSettings({
    wcSessionTopic: session.topic,
    walletAddress: session.address,
    safeAddress,
    clobApiKey: creds.key,
    clobApiSecret: creds.secret,
    clobApiPassphrase: creds.passphrase,
  })

  void trackEvent('wallet_connect_success', settings)
  return { topic: session.topic, address: session.address, safeAddress, creds }
}

/**
 * Restore a previously connected wallet on popup open. Returns null if no
 * session is stored or the WC relay no longer recognizes it.
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
  const session = await restoreSession()
  if (!session || session.topic !== s.wcSessionTopic) {
    // Topic changed under us; clear stale state.
    await saveSettings({
      wcSessionTopic: undefined,
      walletAddress: undefined,
      safeAddress: undefined,
      clobApiKey: undefined,
      clobApiSecret: undefined,
      clobApiPassphrase: undefined,
    })
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

export async function disconnectWallet(state: WalletState | null): Promise<void> {
  if (state) await wcDisconnect(state.topic)
  await saveSettings({
    wcSessionTopic: undefined,
    walletAddress: undefined,
    safeAddress: undefined,
    clobApiKey: undefined,
    clobApiSecret: undefined,
    clobApiPassphrase: undefined,
  })
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
      const size = Math.floor((args.sizeUsd / args.price) * 100) / 100
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

function sizeBucket(usd: number): string {
  if (usd < 10) return 'lt_10'
  if (usd < 50) return '10_50'
  if (usd < 200) return '50_200'
  if (usd < 1000) return '200_1k'
  return 'gt_1k'
}

export interface OrderbookSnapshot {
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
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
