import type { PolyMarket } from './types'
import { findOutcomeIndex, isBinaryOutcomes } from './util'

export type Outcome = 'Yes' | 'No'

export interface OrderTarget {
  tokenId: string
  negRisk: boolean
  tickSize?: string
  /** Market's minimum order size in shares (see ./orderSize). */
  minOrderSize?: number
}

/**
 * The only place an outcome ('Yes'/'No') maps to a `tokenId`. Callers (MCP
 * tools, extension trade flow) must never accept a raw tokenId from outside
 * this function for an order - otherwise a caller can claim "No" while
 * supplying the YES token, and the mismatch is invisible until the wrong
 * side fills. negRisk/tickSize are market properties, not order intent, so
 * they ride along here rather than being separately caller-supplied (which
 * would let a caller spoof them too).
 *
 * Markets reached via the market-cache are pre-filtered to Yes/No by
 * isBinaryOutcomes at build time, but the MCP server's Gamma fallback
 * (resolveMarket.ts, for a marketId outside the cache's top-N-by-volume cut)
 * applies no such filter. Without this check, findOutcomeIndex's silent
 * positional fallback (no 'Yes'/'No' label found → index 0/1) would sign a
 * real order against whatever outcome happens to sit at that index on a
 * market like ["Over","Under"] - never validated against caller intent.
 */
export function resolveOrderToken(market: PolyMarket, outcome: Outcome): OrderTarget {
  if (!isBinaryOutcomes(market.outcomes)) {
    throw new Error('market_not_binary')
  }
  const idx = findOutcomeIndex(market.outcomes, outcome)
  const tokenId = market.clobTokenIds[idx]
  if (!tokenId) {
    throw new Error(`market_missing_token_for_outcome:${outcome}`)
  }
  return {
    tokenId,
    negRisk: market.negRisk ?? false,
    tickSize: market.tickSize,
    minOrderSize: market.minOrderSize,
  }
}
