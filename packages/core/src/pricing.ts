/**
 * Tick-aware price math for order tickets.
 *
 * Lives in core rather than in the extension because both clients need the
 * same answers: the popup computes a market order's cap/floor for the user,
 * and the MCP server has to hand an agent a price it can actually pass. When
 * this lived only in the extension, the MCP side had no guidance at all and
 * an agent picking "the bid" for a market sell would hit exactly the
 * fill-or-kill failure the floor logic exists to prevent.
 */

/** Top of book, as both clients read it. */
export interface BookTop {
  bestBid: number | null
  bestAsk: number | null
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
 * Worst acceptable price for a market SELL: bestBid × (1 − floor), rounded
 * DOWN to the tick, and never above one tick below the bid.
 *
 * The rounding direction is the whole point, and getting it wrong made cheap
 * positions unsellable. The sell ticket used to round to the NEAREST tick,
 * which at low prices rounds the cushion straight back into the bid: a 1.1¢
 * bid gives 1.1¢ × 0.98 = 1.078¢, which rounds to 1.1¢ — the bid itself. The
 * order then goes out as fill-or-kill at exactly the top of the book, so it
 * can only fill if the ENTIRE size is resting on that one price level, and
 * any movement kills it. Below 2.5¢ a 2% cushion is smaller than half a tick,
 * so every market sell in that range was structurally doomed.
 *
 * Rounding down is also what makes this the true mirror of marketCapPrice,
 * which rounds a BUY's cap up and has therefore always had its cushion.
 *
 * Returns at most one tick below the bid and at least one tick outright,
 * since a price of zero is not a valid order. A bid already sitting on the
 * minimum tick therefore yields no cushion at all — unavoidable, and the
 * caller is expected to say so rather than promise slippage it cannot give.
 */
export function marketFloorPrice(bestBid: number, floorPct: number, tickSize: string): number {
  const tick = parseFloat(tickSize)
  const decimals = tickDecimals(tickSize)
  const raw = bestBid * (1 - floorPct)
  const ratio = parseFloat((raw / tick).toFixed(6))
  const floored = snap(Math.floor(ratio), tick, decimals)
  const oneTickDown = snap(Math.round(parseFloat((bestBid / tick).toFixed(6))) - 1, tick, decimals)
  return Math.max(tick, Math.min(floored, oneTickDown))
}

/** Slippage the caller is actually accepting, as a fraction of the bid. */
export function floorSlippage(bestBid: number, floorPrice: number): number {
  if (!(bestBid > 0)) return 0
  return (bestBid - floorPrice) / bestBid
}
