/**
 * UI-side ops adapter — sends heavy operations to the offscreen
 * document via the service worker. Used by the popup.
 *
 * The popup must not call the heavy background/* modules directly: the
 * offscreen document is the single MV3-correct home for WASM embeddings,
 * the WalletConnect relay, and CLOB signing.
 */
import type {
  OffscreenPlaceOrderArgs,
  OffscreenResponse,
  OffscreenSellOrderArgs,
  SerializableWalletState,
} from '../shared/messages'
import type { ArticleData } from '../shared/types'
import type { MatchResult, PolyMarket } from '@actually/core'
import type { OpenOrderSummary, Position } from '../shared/types'
import type { GeoErrorReason } from '../background/geo'

async function call<T extends OffscreenResponse>(msg: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T
}

export async function runMatchViaOffscreen(article: ArticleData): Promise<{
  match: MatchResult | null
  reason?: string
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_MATCH_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_RUN_MATCH',
    article,
  })
  if (r.type === 'OS_ERROR') return { match: null, reason: r.error }
  return { match: r.match, reason: r.reason }
}

export async function refreshCacheViaOffscreen(): Promise<{
  added: number
  reused: number
  removed: number
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_CACHE_REFRESHED' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_REFRESH_CACHE',
  })
  if (r.type === 'OS_ERROR') throw new Error(r.error)
  return { added: r.added, reused: r.reused, removed: r.removed }
}

export async function getGeoViaOffscreen(): Promise<{
  country: string
  blocked: boolean
  unknown: boolean
  errorReason?: GeoErrorReason
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_GEO_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_GET_GEO',
  })
  if (r.type === 'OS_ERROR') return { country: '', blocked: true, unknown: true, errorReason: 'network' }
  return {
    country: r.country,
    blocked: r.blocked,
    unknown: r.unknown,
    errorReason: r.errorReason as GeoErrorReason | undefined,
  }
}

export async function restoreWalletViaOffscreen(): Promise<SerializableWalletState | null> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_WALLET_RESTORED' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_RESTORE_WALLET',
  })
  if (r.type === 'OS_ERROR') return null
  return r.wallet
}

export async function disconnectWalletViaOffscreen(): Promise<void> {
  await call({ target: 'offscreen', type: 'OS_DISCONNECT_WALLET' })
}

/**
 * Two-step connect. Resolves to a sessionId immediately; the caller
 * polls `pollConnectViaOffscreen(sessionId)` to receive the URI then
 * the final wallet (or error).
 */
export async function startConnectViaOffscreen(): Promise<string> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_CONNECT_STARTED' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_START_CONNECT',
  })
  if (r.type === 'OS_ERROR') throw new Error(r.error)
  return r.sessionId
}

/** Omit `sessionId` to ask about whatever connect the offscreen document is
 * currently running — used when the popup was closed mid-connect and no
 * longer has its own id. */
export async function pollConnectViaOffscreen(sessionId?: string): Promise<{
  stage: 'pending' | 'awaiting_approval' | 'signing' | 'done' | 'error'
  uri?: string
  wallet?: SerializableWalletState
  error?: string
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_CONNECT_STATUS' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_POLL_CONNECT',
    sessionId,
  })
  if (r.type === 'OS_ERROR') return { stage: 'error', error: r.error }
  return { stage: r.stage, uri: r.uri, wallet: r.wallet, error: r.error }
}

export async function placeOrderViaOffscreen(
  args: OffscreenPlaceOrderArgs,
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_ORDER_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_PLACE_ORDER',
    args,
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, orderId: r.orderId, error: r.error }
}

export async function sellOrderViaOffscreen(
  args: OffscreenSellOrderArgs,
): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_ORDER_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_SELL_ORDER',
    args,
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, orderId: r.orderId, error: r.error }
}

export async function redeemPositionViaOffscreen(
  conditionId: string,
): Promise<{ ok: boolean; transactionId?: string; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_REDEEM_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_REDEEM_POSITION',
    conditionId,
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, transactionId: r.transactionId, error: r.error }
}

export async function resolveHistoryMarketViaOffscreen(
  marketId: string,
): Promise<{ market: PolyMarket | null; error?: 'not_found' | 'closed' }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_HISTORY_MARKET_RESOLVED' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_RESOLVE_HISTORY_MARKET',
    marketId,
  })
  if (r.type === 'OS_ERROR') return { market: null, error: 'not_found' }
  return { market: r.market, error: r.error }
}

export async function getOpenOrdersViaOffscreen(
  marketId?: string,
): Promise<{ ok: boolean; orders?: OpenOrderSummary[]; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_OPEN_ORDERS_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_GET_OPEN_ORDERS',
    marketId,
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, orders: r.orders, error: r.error }
}

export async function getPositionsViaOffscreen(): Promise<{ ok: boolean; positions?: Position[]; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_POSITIONS_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_GET_POSITIONS',
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, positions: r.positions, error: r.error }
}

export async function cancelOrderViaOffscreen(
  orderId: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_ORDER_RESULT' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_CANCEL_ORDER',
    orderId,
  })
  if (r.type === 'OS_ERROR') return { ok: false, error: r.error }
  return { ok: r.ok, error: r.error }
}

export async function priceHistoryViaOffscreen(
  marketIdOrTokenId: string,
  days = 7,
): Promise<Array<{ t: number; p: number }>> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_PRICE_HISTORY' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_PRICE_HISTORY',
    marketIdOrTokenId,
    days,
  })
  if (r.type === 'OS_ERROR') return []
  return r.points
}

export async function orderbookSnapshotViaOffscreen(
  tokenId: string,
  sizeShares?: number,
): Promise<{
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  bids: Array<{ price: number; size: number }>
  asks: Array<{ price: number; size: number }>
  estimate: { effectivePrice: number; slippage: number } | null
  /** Set when the lookup itself failed (e.g. 'wallet_not_restored') — distinct
   * from a successful lookup that legitimately found an empty book. */
  error?: string
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_ORDERBOOK' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_ORDERBOOK_SNAPSHOT',
    tokenId,
    sizeShares,
  })
  if (r.type === 'OS_ERROR') {
    return { bestBid: null, bestAsk: null, spread: null, bids: [], asks: [], estimate: null, error: r.error }
  }
  return { bestBid: r.bestBid, bestAsk: r.bestAsk, spread: r.spread, bids: r.bids, asks: r.asks, estimate: r.estimate ?? null }
}
