import { findMatch, type Embedder, type MarketStore, type MatchThresholds } from '@actually/core'

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
  /** Objective market YES price — never a synthesized "implied probability" from tone. */
  marketProbabilityYes?: number
  confidence?: number
  lowConfidence?: boolean
  alternatives?: Array<{ marketId: string; question: string }>
  reason?: string
}

export interface CheckNewsDeps {
  store: MarketStore
  embedder: Embedder
  thresholds: MatchThresholds
}

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
  const match = await findMatch(text, text, deps)
  if (!match) {
    return { hasMarket: false, reason: 'no_market_above_floor' }
  }

  return {
    hasMarket: true,
    market: {
      marketId: match.market.id,
      slug: match.market.slug,
      question: match.market.question,
      endDate: match.market.endDate,
      clobTokenIds: match.market.clobTokenIds,
      negRisk: match.market.negRisk ?? false,
      tickSize: match.market.tickSize,
    },
    marketProbabilityYes: match.probability,
    confidence: match.confidence,
    lowConfidence: match.lowConfidence,
    alternatives: match.alternatives.slice(0, 3).map((m) => ({ marketId: m.id, question: m.question })),
  }
}
