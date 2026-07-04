import type { PolyMarket } from './types'
import { findOutcomeIndex } from './util'

export type Outcome = 'Yes' | 'No'

export interface OrderTarget {
  tokenId: string
  negRisk: boolean
  tickSize?: string
}

/**
 * The only place an outcome ('Yes'/'No') maps to a `tokenId`. Callers (MCP
 * tools, extension trade flow) must never accept a raw tokenId from outside
 * this function for an order — otherwise a caller can claim "No" while
 * supplying the YES token, and the mismatch is invisible until the wrong
 * side fills. negRisk/tickSize are market properties, not order intent, so
 * they ride along here rather than being separately caller-supplied (which
 * would let a caller spoof them too).
 */
export function resolveOrderToken(market: PolyMarket, outcome: Outcome): OrderTarget {
  const idx = findOutcomeIndex(market.outcomes, outcome)
  const tokenId = market.clobTokenIds[idx]
  if (!tokenId) {
    throw new Error(`market_missing_token_for_outcome:${outcome}`)
  }
  return { tokenId, negRisk: market.negRisk ?? false, tickSize: market.tickSize }
}
