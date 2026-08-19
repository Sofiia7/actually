import type {
  ArticleData,
  HistoryItem,
  MatchResult,
  OpenOrderSummary,
  PolyMarket,
  Position,
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
  | { target: 'offscreen'; type: 'OS_BUILDER_STATUS' }
  | { target: 'offscreen'; type: 'OS_RESTORE_WALLET' }
  | { target: 'offscreen'; type: 'OS_DISCONNECT_WALLET' }
  | { target: 'offscreen'; type: 'OS_START_CONNECT' }
  // `sessionId` is optional: the popup loses it whenever Chrome closes the
  // popup (which happens on any focus loss — including switching to the
  // wallet app). Omitting it asks for whatever connect the offscreen document
  // currently knows about, so a reopened popup can rejoin one already in
  // flight instead of stranding it and starting another.
  | { target: 'offscreen'; type: 'OS_POLL_CONNECT'; sessionId?: string }
  | { target: 'offscreen'; type: 'OS_PLACE_ORDER'; args: OffscreenPlaceOrderArgs }
  | { target: 'offscreen'; type: 'OS_SELL_ORDER'; args: OffscreenSellOrderArgs }
  | { target: 'offscreen'; type: 'OS_REDEEM_POSITION'; conditionId: string }
  | { target: 'offscreen'; type: 'OS_CANCEL_ORDER'; orderId: string }
  | { target: 'offscreen'; type: 'OS_GET_OPEN_ORDERS'; marketId?: string }
  | { target: 'offscreen'; type: 'OS_GET_POSITIONS' }
  | { target: 'offscreen'; type: 'OS_ORDERBOOK_SNAPSHOT'; tokenId: string; sizeShares?: number }
  | { target: 'offscreen'; type: 'OS_PRICE_HISTORY'; marketIdOrTokenId: string; days?: number }
  | { target: 'offscreen'; type: 'OS_RESOLVE_HISTORY_MARKET'; marketId: string }

export interface OffscreenPlaceOrderArgs {
  tokenId: string
  side: 'BUY_YES' | 'BUY_NO'
  sizeUsd: number
  /** LIMIT → the resting limit price; MARKET → the worst-acceptable cap price. */
  price: number
  negRisk: boolean
  /** Optional tick size override from the matched market (e.g. "0.001"). */
  tickSize?: string
  /** Market's minimum order size in shares; falls back to the platform default. */
  minOrderSize?: number
  /** LIMIT → GTC resting order at `price`; MARKET → FOK capped at `price`. */
  orderType: 'LIMIT' | 'MARKET'
  /** UI-derived maker/taker classification — telemetry only. */
  makerTaker?: 'maker' | 'taker'
}

export interface OffscreenSellOrderArgs {
  tokenId: string
  /** Shares to sell — a sell is denominated in what you hold, not in USD. */
  sizeShares: number
  /** LIMIT → the resting limit price; MARKET → the worst-acceptable FLOOR price. */
  price: number
  /**
   * OMIT unless the caller holds a trusted Gamma record for this market. The
   * CLOB SDK only auto-resolves the market's real neg-risk flag when the
   * option is absent (`options?.negRisk ?? await getNegRisk(tokenID)`) — an
   * explicit `false` here forces the normal exchange contract and gets every
   * neg-risk sell rejected with a signature error. Positions come from the
   * data API with no Gamma record, so the sell ticket must not send this.
   */
  negRisk?: boolean
  tickSize?: string
  minOrderSize?: number
  orderType: 'LIMIT' | 'MARKET'
}

export type OffscreenResponse =
  | { type: 'OS_PONG' }
  | {
      type: 'OS_MATCH_RESULT'
      match: MatchResult | null
      reason?: string
      /** Closest tradeable market when nothing cleared the floor — lets the
       *  UI say what it nearly matched instead of printing cache counters. */
      nearest?: { question: string; slug: string; score: number }
      /** How many markets were scoreable at all (open, embedded, unexpired). */
      scored?: number
    }
  | { type: 'OS_CACHE_REFRESHED'; added: number; reused: number; removed: number }
  | { type: 'OS_BUILDER_STATUS_RESULT'; available: boolean }
  | { type: 'OS_GEO_RESULT'; country: string; blocked: boolean; unknown: boolean; errorReason?: string }
  | { type: 'OS_WALLET_RESTORED'; wallet: SerializableWalletState | null }
  | { type: 'OS_REDEEM_RESULT'; ok: boolean; transactionId?: string; error?: string }
  | { type: 'OS_CONNECT_STARTED'; sessionId: string }
  | {
      type: 'OS_CONNECT_STATUS'
      /** `signing` = session approved, now waiting on the CLOB-auth signature —
       * a SECOND prompt the wallet raises separately from the QR approval. */
      stage: 'pending' | 'awaiting_approval' | 'signing' | 'done' | 'error'
      uri?: string
      wallet?: SerializableWalletState
      error?: string
    }
  | { type: 'OS_ORDER_RESULT'; ok: boolean; orderId?: string; error?: string }
  | {
      type: 'OS_ORDERBOOK'
      bestBid: number | null
      bestAsk: number | null
      spread: number | null
      bids: Array<{ price: number; size: number }>
      asks: Array<{ price: number; size: number }>
      estimate?: { effectivePrice: number; slippage: number } | null
    }
  | { type: 'OS_PRICE_HISTORY'; points: Array<{ t: number; p: number }> }
  | { type: 'OS_HISTORY_MARKET_RESOLVED'; market: PolyMarket | null; error?: 'not_found' | 'closed' }
  | { type: 'OS_OPEN_ORDERS_RESULT'; ok: boolean; orders?: OpenOrderSummary[]; error?: string }
  | { type: 'OS_POSITIONS_RESULT'; ok: boolean; positions?: Position[]; error?: string }
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
