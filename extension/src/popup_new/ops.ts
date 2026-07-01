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
  SerializableWalletState,
} from '../shared/messages'
import type { ArticleData } from '../shared/types'
import type { MatchResult } from '@actually/core'
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

export async function pollConnectViaOffscreen(sessionId: string): Promise<{
  stage: 'pending' | 'awaiting_approval' | 'done' | 'error'
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
  estimate: { effectivePrice: number; slippage: number } | null
}> {
  const r = await call<Extract<OffscreenResponse, { type: 'OS_ORDERBOOK' }> | Extract<OffscreenResponse, { type: 'OS_ERROR' }>>({
    target: 'offscreen',
    type: 'OS_ORDERBOOK_SNAPSHOT',
    tokenId,
    sizeShares,
  })
  if (r.type === 'OS_ERROR') return { bestBid: null, bestAsk: null, spread: null, estimate: null }
  return { bestBid: r.bestBid, bestAsk: r.bestAsk, spread: r.spread, estimate: r.estimate ?? null }
}
