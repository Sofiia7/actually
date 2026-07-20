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
  // Wallet state — managed by trade flow, not user-editable directly.
  // All optional until the user connects via WalletConnect v2.
  wcSessionTopic?: string
  walletAddress?: string  // EOA from WC session
  safeAddress?: string    // CREATE2-derived Polymarket Safe
  clobApiKey?: string
  clobApiSecret?: string
  clobApiPassphrase?: string
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
}

export interface TestKeysResult {
  worker: { ok: boolean; error?: string }
  openai?: { ok: boolean; error?: string }
}
