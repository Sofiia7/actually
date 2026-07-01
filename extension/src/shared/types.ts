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
  wcSessionTopic?: string
  walletAddress?: string
  safeAddress?: string
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
    | 'geo_blocked'
    | 'geo_unknown'
    | 'cache_refresh'
  ts: number
  meta?: Record<string, string | number | boolean>
}

export interface TestKeysResult {
  worker: { ok: boolean; error?: string }
  openai?: { ok: boolean; error?: string }
}
