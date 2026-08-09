import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_ORDER_SHARES,
  isBelowMinOrderSize,
  minOrderShares,
  minOrderUsd,
  orderShares,
} from './orderSize'

describe('minOrderShares', () => {
  it('falls back to the platform default when the market does not say', () => {
    expect(minOrderShares(undefined)).toBe(DEFAULT_MIN_ORDER_SHARES)
    expect(minOrderShares(0)).toBe(DEFAULT_MIN_ORDER_SHARES)
    expect(minOrderShares(Number.NaN)).toBe(DEFAULT_MIN_ORDER_SHARES)
  })

  it('honours a per-market minimum when Gamma provides one', () => {
    expect(minOrderShares(20)).toBe(20)
  })
})

describe('orderShares', () => {
  it('truncates to 2dp, matching what the order path actually signs', () => {
    expect(orderShares(1, 0.31)).toBe(3.22) // 3.2258… → 3.22
    expect(orderShares(20, 0.42)).toBe(47.61) // 47.619… → 47.61
  })

  it('returns 0 for non-positive inputs rather than Infinity/NaN', () => {
    expect(orderShares(0, 0.31)).toBe(0)
    expect(orderShares(10, 0)).toBe(0)
  })
})

describe('isBelowMinOrderSize', () => {
  it('rejects the exact order that CLOB rejected: $1 at 31¢ = 3.22 shares', () => {
    expect(isBelowMinOrderSize(1, 0.31, undefined)).toBe(true)
  })

  it('accepts the same $1 where the price is low enough to clear 5 shares', () => {
    expect(isBelowMinOrderSize(1, 0.15, undefined)).toBe(false) // 6.66 shares
  })

  it('is not tripped by float error at an exact boundary', () => {
    expect(isBelowMinOrderSize(minOrderUsd(0.31)!, 0.31, undefined)).toBe(false)
  })

  it('stays quiet on incomplete input (empty price field, zero amount)', () => {
    expect(isBelowMinOrderSize(0, 0.31)).toBe(false)
    expect(isBelowMinOrderSize(1, Number.NaN)).toBe(false)
  })
})

describe('minOrderUsd', () => {
  it('gives a USD floor that really does clear the share minimum', () => {
    for (const price of [0.01, 0.15, 0.31, 0.33, 0.49, 0.5, 0.67, 0.99]) {
      const usd = minOrderUsd(price)!
      expect(orderShares(usd, price)).toBeGreaterThanOrEqual(DEFAULT_MIN_ORDER_SHARES)
      // …and is genuinely minimal: one cent less must fail.
      expect(orderShares(Math.round((usd - 0.01) * 100) / 100, price)).toBeLessThan(
        DEFAULT_MIN_ORDER_SHARES,
      )
    }
  })

  it('is $1.55 at 31¢ — the price from the rejected order', () => {
    expect(minOrderUsd(0.31)).toBe(1.55)
  })

  it('scales with a per-market minimum', () => {
    expect(minOrderUsd(0.5, 20)).toBe(10)
  })

  it('returns null when there is no usable price yet', () => {
    expect(minOrderUsd(0)).toBeNull()
    expect(minOrderUsd(Number.NaN)).toBeNull()
  })
})
