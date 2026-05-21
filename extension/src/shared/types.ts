export interface PolyMarket {
  id: string
  slug: string
  question: string
  outcomePrices: string
  outcomes: string
  volume: number
  liquidity: number
  active: boolean
  closed: boolean
  clobTokenIds: string[]
}

export interface CachedMarket extends PolyMarket {
  embeddingB64: string
  questionHash: string
  cachedAt: number
}

export interface MatchResult {
  market: PolyMarket
  probability: number
  confidence: number
  color: MatchColor
  freshPrice?: number
  lowConfidence: boolean
  alternatives: PolyMarket[]
  alternativeScores?: number[]
}

export type MatchColor = 'blue' | 'yellow' | 'red'

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
  // openaiKey REMOVED: was unused; OpenAI route uses Worker env key
  // builderCode REMOVED: hardcoded at build time via BUILDER_CODE env (see vite.config.ts)
  // powerMode REMOVED: replaced by wallet-connected state (see §11 of spec)
  workerUrl: string
  workerSecret: string
  telemetryEnabled: boolean
  locale: SupportedLocale
  // Wallet state — managed by trade flow, not user-editable directly.
  // All optional until the user connects via WalletConnect v2.
  wcSessionTopic?: string
  walletAddress?: string  // EOA from WC session
  safeAddress?: string    // CREATE2-derived Polymarket Safe
  clobApiKey?: string
  clobApiSecret?: string
  clobApiPassphrase?: string
}

export type SupportedLocale = 'en' | 'es' | 'pt-BR'

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
    | 'cache_refresh'
  ts: number
  meta?: Record<string, string | number | boolean>
}

export interface TestKeysResult {
  worker: { ok: boolean; error?: string }
  openai?: { ok: boolean; error?: string }
}
