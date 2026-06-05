import type {
  ArticleData,
  HistoryItem,
  MatchResult,
  Settings,
  TestKeysResult,
} from './types'

// ============================================================
// Light-weight messages — handled directly by the Service Worker
// (settings, history, telemetry-adjacent state).
// ============================================================
export type RequestMessage =
  | { type: 'EXTRACT_AND_MATCH' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'TEST_KEYS' }
  | { type: 'GET_HISTORY' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'GET_CACHE_STATUS' }
  | { type: 'REFRESH_CACHE_NOW' }
  | {
      type: 'PLACE_ORDER'
      marketId: string
      tokenId: string
      side: 'BUY_YES' | 'BUY_NO'
      sizeUsd: number
      price: number
      negRisk: boolean
    }
  // Offscreen-targeted heavy ops; the SW routes these to the offscreen
  // document and pipes the response back. Listed here so popup and
  // content-script widget share a single message shape.
  | OffscreenRequest

export type ResponseMessage =
  | { type: 'MATCH_RESULT'; result: MatchResult | null; reason?: string }
  | { type: 'SETTINGS_RESPONSE'; settings: Settings }
  | { type: 'OK' }
  | { type: 'TEST_KEYS_RESULT'; result: TestKeysResult }
  | { type: 'HISTORY_RESPONSE'; items: HistoryItem[] }
  | { type: 'CACHE_STATUS'; count: number; lastUpdated: number; refreshing: boolean }
  | { type: 'REFRESH_STARTED' }
  | { type: 'REFRESH_RESULT'; ok: boolean; added: number; reused: number; error?: string }
  | { type: 'ORDER_RESULT'; ok: boolean; orderId?: string; error?: string }
  | { type: 'ERROR'; error: string }
  | OffscreenResponse

export async function sendToBackground<R = ResponseMessage>(
  msg: RequestMessage,
): Promise<R> {
  return (await chrome.runtime.sendMessage(msg)) as R
}

// ============================================================
// Heavy operations — handled inside the offscreen document.
// Routed by the SW via `target: 'offscreen'`.
// ============================================================
export type OffscreenRequest =
  | { target: 'offscreen'; type: 'OS_PING' }
  | { target: 'offscreen'; type: 'OS_RUN_MATCH'; article: ArticleData }
  | { target: 'offscreen'; type: 'OS_REFRESH_CACHE' }
  | { target: 'offscreen'; type: 'OS_GET_GEO' }
  | { target: 'offscreen'; type: 'OS_RESTORE_WALLET' }
  | { target: 'offscreen'; type: 'OS_DISCONNECT_WALLET' }
  | { target: 'offscreen'; type: 'OS_START_CONNECT' }
  | { target: 'offscreen'; type: 'OS_POLL_CONNECT'; sessionId: string }
  | { target: 'offscreen'; type: 'OS_PLACE_ORDER'; args: OffscreenPlaceOrderArgs }
  | { target: 'offscreen'; type: 'OS_ORDERBOOK_SNAPSHOT'; tokenId: string; sizeShares?: number }
  | { target: 'offscreen'; type: 'OS_PRICE_HISTORY'; marketIdOrTokenId: string; days?: number }

export interface OffscreenPlaceOrderArgs {
  tokenId: string
  side: 'BUY_YES' | 'BUY_NO'
  sizeUsd: number
  /** LIMIT → the resting limit price; MARKET → the worst-acceptable cap price. */
  price: number
  negRisk: boolean
  /** Optional tick size override from the matched market (e.g. "0.001"). */
  tickSize?: string
  /** LIMIT → GTC resting order at `price`; MARKET → FOK capped at `price`. */
  orderType: 'LIMIT' | 'MARKET'
  /** UI-derived maker/taker classification — telemetry only. */
  makerTaker?: 'maker' | 'taker'
}

export type OffscreenResponse =
  | { type: 'OS_PONG' }
  | { type: 'OS_MATCH_RESULT'; match: MatchResult | null; reason?: string }
  | { type: 'OS_CACHE_REFRESHED'; added: number; reused: number; removed: number }
  | { type: 'OS_GEO_RESULT'; country: string; blocked: boolean; unknown: boolean; errorReason?: string }
  | { type: 'OS_WALLET_RESTORED'; wallet: SerializableWalletState | null }
  | { type: 'OS_CONNECT_STARTED'; sessionId: string }
  | { type: 'OS_CONNECT_STATUS'; stage: 'pending' | 'awaiting_approval' | 'done' | 'error'; uri?: string; wallet?: SerializableWalletState; error?: string }
  | { type: 'OS_ORDER_RESULT'; ok: boolean; orderId?: string; error?: string }
  | { type: 'OS_ORDERBOOK'; bestBid: number | null; bestAsk: number | null; spread: number | null; estimate?: { effectivePrice: number; slippage: number } | null }
  | { type: 'OS_PRICE_HISTORY'; points: Array<{ t: number; p: number }> }
  | { type: 'OS_ERROR'; error: string }

/**
 * Mirror of WalletState that survives chrome.runtime message serialization.
 * (The real WalletState carries `ApiKeyCreds` from clob-client-v2, which is
 * a plain object too — safe to pass.) Kept separate so the widget can hold
 * it without importing the SDK.
 */
export interface SerializableWalletState {
  topic: string
  address: string
  safeAddress: string
  creds: { key: string; secret: string; passphrase: string }
}
