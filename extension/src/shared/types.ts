export type { PolyMarket, CachedMarket, MatchResult, MatchColor, MarketCacheBlob } from '@actually/core'
import type { MatchColor } from '@actually/core'

export interface ArticleData {
  headline: string
  bodyText: string
  url: string
  domain: string
}

export type EmbeddingProvider = 'local' | 'openai'

export interface Settings {
  confidenceThreshold: number
  lowConfidenceFloor: number
  embeddingProvider: EmbeddingProvider
  workerUrl: string
  workerSecret: string
  telemetryEnabled: boolean
  /**
   * Allow a live Polymarket search when nothing cached matches the article.
   * Off by default: it sends headline keywords off-device, which the
   * local-embedding path otherwise never does.
   */
  searchFallbackEnabled: boolean
  // Wallet state — managed by trade flow, not user-editable directly.
  // All optional until the user connects via WalletConnect v2.
  wcSessionTopic?: string
  walletAddress?: string  // EOA from WC session
  safeAddress?: string    // CREATE2-derived Polymarket Safe
  clobApiKey?: string
  clobApiSecret?: string
  clobApiPassphrase?: string
}

/**
 * One entry in the local activity log — what the user actually did, as
 * opposed to what they looked at (HistoryItem). Written for buys, sells and
 * redeems alike, on success AND on failure, because "did my sell go through?"
 * is exactly the question that has no other answer once the position is gone
 * from Polymarket's positions API.
 */
export interface TradeLogItem {
  id: string
  timestamp: number
  kind: 'BUY' | 'SELL' | 'REDEEM'
  status: 'placed' | 'failed' | 'unknown'
  /** Market question, as shown at the time of the trade. */
  question: string
  /** Market slug for the Polymarket link, when known. */
  marketSlug?: string
  /** 'Yes' / 'No' — which outcome token the trade was on. */
  outcome?: string
  orderType?: 'LIMIT' | 'MARKET'
  /** BUY: USD notional. SELL: proceeds estimate. REDEEM: unset. */
  usd?: number
  /** SELL/BUY: share count when known. */
  shares?: number
  /** Price per share (0..1) the order was signed at. */
  price?: number
  /** CLOB order id (BUY/SELL) or relayer transaction id (REDEEM). */
  ref?: string
  /** Human-readable failure reason when status !== 'placed'. */
  error?: string
}

export interface HistoryItem {
  marketId: string
  marketSlug: string
  question: string
  probability: number
  color: MatchColor
  lowConfidence: boolean
  pageUrl: string
  pageDomain: string
  timestamp: number
}

export interface TelemetryEvent {
  installId: string
  event:
    | 'install'
    | 'check_page_clicked'
    | 'match_shown'
    | 'match_lowconf'
    | 'match_clicked'
    | 'no_match'
    | 'wallet_connect_started'
    | 'wallet_connect_success'
    | 'wallet_connect_failed'
    | 'order_form_opened'
    | 'order_signed'
    | 'order_submitted'
    | 'order_filled'
    | 'order_failed'
    | 'order_cancelled'
    | 'order_cancel_failed'
    | 'geo_blocked'
    | 'geo_unknown'
    | 'cache_refresh'
  ts: number
  meta?: Record<string, string | number | boolean>
}

export interface OpenOrderSummary {
  orderId: string
  marketId: string
  tokenId: string
  side: string
  price: string
  originalSize: string
  sizeMatched: string
  status: string
  /** e.g. "Yes"/"No" — lets the UI show which outcome an order is on, not just its price/size. */
  outcome: string
}

export interface Position {
  tokenId: string
  conditionId: string
  size: number
  avgPrice: number
  curPrice: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  outcome: string
  title: string
  slug: string
  /** True once the market has resolved and this position can be redeemed. */
  redeemable: boolean
  /** 0 or 1 — which binary outcome slot these tokens occupy. Required to build
   * a neg-risk redeem, which takes explicit per-slot amounts. */
  outcomeIndex: number
  /** Neg-risk markets redeem through a different contract with a different
   * calling convention entirely — see @actually/core's buildRedeemTransaction. */
  negativeRisk: boolean
}

export interface TestKeysResult {
  worker: { ok: boolean; error?: string }
  openai?: { ok: boolean; error?: string }
}
