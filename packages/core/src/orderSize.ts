/**
 * Minimum order size — the CLOB rejects any order whose SHARE count falls
 * below the market's `minimum_order_size`. Gamma exposes the same number as
 * `orderMinSize` (carried on `PolyMarket.minOrderSize`); every market on
 * clob.polymarket.com/sampling-markets reported 5 when this was checked
 * (2026-08-09, 1000/1000 markets), which is the fallback here.
 *
 * The constraint bites harder than the number suggests, because it is on
 * shares and not dollars: the USD floor scales with price, so a $1 order is
 * fine at 15¢ (6.6 shares) and rejected at 31¢ (3.2 shares). Without a
 * client-side check the user pays a wallet signature before CLOB says no —
 * and CLOB's rejection arrives as a bare HTTP 400, which is exactly the
 * "Failed: clob_rejected" dead end this module exists to prevent.
 */
export const DEFAULT_MIN_ORDER_SHARES = 5

/** Per-market minimum in shares, falling back to the platform default. */
export function minOrderShares(minOrderSize?: number): number {
  return typeof minOrderSize === 'number' && Number.isFinite(minOrderSize) && minOrderSize > 0
    ? minOrderSize
    : DEFAULT_MIN_ORDER_SHARES
}

/**
 * Shares a USD notional buys at `price`, truncated to 2dp.
 *
 * This is THE conversion the order path uses (trade.ts signs exactly this
 * size), so the minimum-size guard must measure the same quantity — checking
 * the untruncated `sizeUsd / price` instead would pass $1.55 @ 31¢ (5.0
 * shares in exact math, 4.99 after float error + truncation) straight into a
 * CLOB rejection.
 */
export function orderShares(sizeUsd: number, price: number): number {
  if (!(sizeUsd > 0) || !(price > 0)) return 0
  return Math.floor((sizeUsd / price) * 100) / 100
}

/**
 * Smallest whole-cent USD notional that still buys `minOrderShares` at
 * `price`. Derived by inverting `orderShares` and then verifying, rather than
 * computed in closed form: `shares × price` rounded up to the cent can still
 * land a hair short once `orderShares`' own truncation is applied, so the
 * result is nudged up by a cent until it actually clears.
 */
export function minOrderUsd(price: number, minOrderSize?: number): number | null {
  if (!(price > 0) || !Number.isFinite(price)) return null
  const min = minOrderShares(minOrderSize)
  // 1e-9 absorbs binary-float error so an exact multiple (5 × 0.31 = 1.55)
  // doesn't get rounded up to 1.56 by a trailing ...0000003.
  let usd = Math.ceil(min * price * 100 - 1e-9) / 100
  for (let i = 0; i < 3 && orderShares(usd, price) < min; i++) {
    usd = Math.round((usd + 0.01) * 100) / 100
  }
  return usd
}

/** True when `sizeUsd` at `price` buys fewer shares than the market allows. */
export function isBelowMinOrderSize(
  sizeUsd: number,
  price: number,
  minOrderSize?: number,
): boolean {
  if (!(sizeUsd > 0) || !(price > 0) || !Number.isFinite(price)) return false
  return orderShares(sizeUsd, price) < minOrderShares(minOrderSize)
}
