export interface PolyMarket {
  id: string
  slug: string
  /**
   * Slug of the parent EVENT, when Gamma reports one. polymarket.com routes
   * public pages on /event/<event-slug>; the market's own slug is a different
   * identifier that frequently 404s (observed live 2026-08-16 on
   * "us-announces-end-of-iranian-blockade-by-august-22-2026"). Prefer this
   * for links, fall back to `slug`.
   */
  eventSlug?: string
  question: string
  outcomePrices: string
  outcomes: string
  volume: number
  liquidity: number
  active: boolean
  closed: boolean
  clobTokenIds: string[]
  /** ISO timestamp of market resolution. */
  endDate?: string
  /** Rules excerpt. */
  description?: string
  /** Oracle / committee name from Gamma. */
  resolutionSource?: string
  /** True if this is a neg-risk event (different CLOB tick/contract config). */
  negRisk?: boolean
  /**
   * Minimum price tick for orders, as a decimal string (e.g. "0.01" or
   * "0.001"). When absent callers fall back to `negRisk ? '0.001' : '0.01'`,
   * but Gamma provides this directly on most markets - using the real
   * value prevents CLOB from rejecting orders with `invalid_tick`.
   */
  tickSize?: string
  /**
   * Minimum order size in SHARES (Gamma's `orderMinSize`, mirroring CLOB's
   * `minimum_order_size`). Absent on records that predate this field -
   * callers fall back to DEFAULT_MIN_ORDER_SHARES (see ./orderSize).
   */
  minOrderSize?: number
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

/** Envelope served by the worker's `GET /market-cache` and produced by the precompute script. */
export interface MarketCacheBlob {
  /** Embedding model identity - MUST match LOCAL_MODEL_ID or callers must reject the blob. */
  model: string
  builtAt: number
  markets: CachedMarket[]
}
