import { attemptMatch, type Embedder, type MarketStore, type MatchThresholds, type PolyMarket } from '@actually/core'

export interface CheckNewsInput {
  text: string
}

export interface CheckNewsMarket {
  marketId: string
  slug: string
  question: string
  endDate?: string
  clobTokenIds: string[]
  negRisk: boolean
  tickSize?: string
}

export interface CheckNewsOutput {
  hasMarket: boolean
  market?: CheckNewsMarket
  /**
   * Objective market YES price - never a synthesized "implied probability"
   * from tone. Sourced from the precomputed /market-cache blob, which can be
   * up to ~2h stale (cron precompute cadence); call get_market for a live price.
   */
  marketProbabilityYes?: number
  confidence?: number
  lowConfidence?: boolean
  alternatives?: Array<{ marketId: string; question: string }>
  reason?: 'empty_text' | 'no_market_above_floor'
  /**
   * On a miss: the market this came CLOSEST to, and how many were compared.
   *
   * A bare `no_market_above_floor` tells an agent nothing it can act on - it
   * cannot distinguish "Polymarket has nothing on this subject" from "the
   * cached shelf is a fixed size and the relevant market is below the cut".
   * Those call for opposite next moves, so the tool now says which it was.
   */
  nearest?: { question: string; slug: string; score: number }
  /** Markets actually compared: open, embedded, not past their end date. */
  marketsCompared?: number
}

export interface CheckNewsDeps {
  store: MarketStore
  embedder: Embedder
  thresholds: MatchThresholds
  /**
   * Optional long-tail lookup, consulted only when the cached set produces
   * nothing above the floor. Opt-in for the same reason as in the extension:
   * the query is built from the caller's text and leaves the machine.
   */
  searchFallback?: (headline: string) => Promise<PolyMarket[]>
}

// Errors from deps.store/deps.embedder (network failures, model load
// failures, etc.) propagate uncaught - the MCP tool-registration layer is
// responsible for catching and converting to a tool-error response.
export async function checkNews(deps: CheckNewsDeps, input: CheckNewsInput): Promise<CheckNewsOutput> {
  const text = input.text.trim()
  if (text.length === 0) {
    return { hasMarket: false, reason: 'empty_text' }
  }

  // No headline/body split exists for an arbitrary agent-supplied text, so the
  // same text is passed as both: the headline-side keeps the keyword-overlap
  // discriminator (see @actually/core's matcher.ts) alive, and the body-side
  // is where findMatch's own MAX_BODY_TEXT_CHARS truncation already bounds
  // the embedding input length.
  const attempt = await attemptMatch(text, text, deps)
  const match = attempt.match
  if (!match) {
    return {
      hasMarket: false,
      reason: 'no_market_above_floor',
      nearest: attempt.nearest ?? undefined,
      marketsCompared: attempt.scored,
    }
  }

  return {
    hasMarket: true,
    market: {
      marketId: match.market.id,
      slug: match.market.slug,
      question: match.market.question,
      endDate: match.market.endDate,
      clobTokenIds: match.market.clobTokenIds,
      negRisk: match.market.negRisk ?? false, // Polymarket data model: absence means false.
      tickSize: match.market.tickSize,
    },
    marketProbabilityYes: match.probability,
    confidence: match.confidence,
    lowConfidence: match.lowConfidence,
    // Trim further than findMatch's own cap of 4 - keeps the agent's context
    // small; findMatch already ranked these by relevance.
    alternatives: match.alternatives.slice(0, 3).map((m) => ({ marketId: m.id, question: m.question })),
  }
}
