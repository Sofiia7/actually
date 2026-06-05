/**
 * Pure order-ticket math for the Trade tab. No chrome.* / SDK imports — kept
 * unit-testable in isolation (see orderMath.test.ts). All prices are per-share
 * in USDC (0..1); sizes are USD notional unless named `shares`.
 */
export type OrderType = 'LIMIT' | 'MARKET'

export interface BookTop {
  bestBid: number | null
  bestAsk: number | null
}

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

function tickDecimals(tickSize: string): number {
  const dot = tickSize.indexOf('.')
  return dot < 0 ? 0 : tickSize.length - dot - 1
}

function snap(steps: number, tick: number, decimals: number): number {
  return parseFloat((steps * tick).toFixed(decimals))
}

/** Round a price DOWN to the nearest valid tick multiple. */
export function roundToTick(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize)
  if (!Number.isFinite(tick) || tick <= 0) return price
  const ratio = parseFloat((price / tick).toFixed(6))
  return snap(Math.floor(ratio), tick, tickDecimals(tickSize))
}

/** True if `price` is tick-aligned and strictly inside (0, 1). */
export function isValidTickPrice(price: number, tickSize: string): boolean {
  if (!(price > 0) || !(price < 1)) return false
  return Math.abs(price - roundToTick(price, tickSize)) < 1e-9
}

/** Default price to pre-fill for a BUY: the current best ask. */
export function defaultBuyPrice(book: BookTop): number | null {
  return book.bestAsk
}

/**
 * Worst acceptable price for a market BUY: bestAsk × (1 + cap), rounded UP to
 * the tick, clamped strictly below 1 so the order stays valid.
 */
export function marketCapPrice(bestAsk: number, capPct: number, tickSize: string): number {
  const tick = parseFloat(tickSize)
  const decimals = tickDecimals(tickSize)
  const raw = bestAsk * (1 + capPct)
  const ratio = parseFloat((raw / tick).toFixed(6))
  const capped = snap(Math.ceil(ratio), tick, decimals)
  const maxValid = snap(Math.round(1 / tick) - 1, tick, decimals) // 1 − tick
  return Math.min(capped, maxValid)
}

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
