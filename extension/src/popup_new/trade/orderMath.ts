/**
 * Pure order-ticket math for the Trade tab. No chrome.* / SDK imports — kept
 * unit-testable in isolation (see orderMath.test.ts). All prices are per-share
 * in USDC (0..1); sizes are USD notional unless named `shares`.
 */
export type OrderType = 'LIMIT' | 'MARKET'

/** Shares received for a USD notional at a given per-share price. */
export function sharesFor(sizeUsd: number, price: number): number {
  if (sizeUsd <= 0 || price <= 0) return 0
  return sizeUsd / price
}

/** Max payout if the position resolves correct — $1 per share. */
export function maxPayout(shares: number): number {
  return shares
}

/** Return as a fraction of stake: (payout − size) / size. */
export function returnFraction(sizeUsd: number, shares: number): number {
  if (sizeUsd <= 0) return 0
  return (maxPayout(shares) - sizeUsd) / sizeUsd
}

// Tick/price math moved to @actually/core (see its pricing.ts): the MCP
// server needs the identical rules, and two copies would drift.
export type { BookTop } from '@actually/core'
import type { BookTop } from '@actually/core'
export {
  defaultBuyPrice,
  roundToTick,
  isValidTickPrice,
  marketCapPrice,
  marketFloorPrice,
  floorSlippage,
} from '@actually/core'

/**
 * Classify a BUY as maker (rests on the book) or taker (crosses the spread).
 * Market orders always take. A limit at/above best ask crosses; below rests.
 * Unknown ask → treat as maker (we can't cross what we can't see).
 */
export function makerOrTaker(
  orderType: OrderType,
  limitPrice: number,
  book: BookTop,
): 'maker' | 'taker' {
  if (orderType === 'MARKET') return 'taker'
  if (book.bestAsk == null) return 'maker'
  return limitPrice >= book.bestAsk ? 'taker' : 'maker'
}
