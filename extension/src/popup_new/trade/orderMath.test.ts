import { describe, expect, it } from 'vitest'
import {
  sharesFor,
  maxPayout,
  returnFraction,
  roundToTick,
  isValidTickPrice,
  defaultBuyPrice,
  marketCapPrice,
  makerOrTaker,
} from './orderMath'

describe('sharesFor', () => {
  it('shares = size / price', () => {
    expect(sharesFor(20, 0.25)).toBeCloseTo(80, 6)
  })
  it('returns 0 when price is 0 (avoid Infinity)', () => {
    expect(sharesFor(20, 0)).toBe(0)
  })
  it('returns 0 for non-positive size', () => {
    expect(sharesFor(0, 0.25)).toBe(0)
    expect(sharesFor(-5, 0.25)).toBe(0)
  })
})

describe('maxPayout', () => {
  it('payout = shares (each share pays $1 if correct)', () => {
    expect(maxPayout(80)).toBe(80)
  })
})

describe('returnFraction', () => {
  it('(payout - size) / size', () => {
    // 20 USD @ 0.25 → 80 shares → payout 80 → return (80-20)/20 = 3.0
    expect(returnFraction(20, 80)).toBeCloseTo(3, 6)
  })
  it('returns 0 for non-positive size', () => {
    expect(returnFraction(0, 80)).toBe(0)
  })
})

describe('roundToTick', () => {
  it('snaps down to the nearest multiple of the tick', () => {
    expect(roundToTick(0.237, '0.01')).toBeCloseTo(0.23, 6)
    expect(roundToTick(0.2349, '0.001')).toBeCloseTo(0.234, 6)
  })
  it('passes through an already-aligned price', () => {
    expect(roundToTick(0.25, '0.01')).toBeCloseTo(0.25, 6)
  })
})

describe('isValidTickPrice', () => {
  it('true for an aligned price strictly inside (0,1)', () => {
    expect(isValidTickPrice(0.25, '0.01')).toBe(true)
  })
  it('false for a misaligned price', () => {
    expect(isValidTickPrice(0.237, '0.01')).toBe(false)
  })
  it('false at or outside the (0,1) bounds', () => {
    expect(isValidTickPrice(0, '0.01')).toBe(false)
    expect(isValidTickPrice(1, '0.01')).toBe(false)
    expect(isValidTickPrice(1.5, '0.01')).toBe(false)
  })
})

describe('defaultBuyPrice', () => {
  it('uses best ask for a BUY', () => {
    expect(defaultBuyPrice({ bestBid: 0.23, bestAsk: 0.25 })).toBeCloseTo(0.25, 6)
  })
  it('null when ask unknown', () => {
    expect(defaultBuyPrice({ bestBid: 0.23, bestAsk: null })).toBeNull()
  })
})

describe('marketCapPrice', () => {
  it('caps a market BUY at bestAsk*(1+cap), rounded up to the tick', () => {
    // 0.50 * 1.02 = 0.51 → already a 0.01 multiple
    expect(marketCapPrice(0.5, 0.02, '0.01')).toBeCloseTo(0.51, 6)
    // 0.25 * 1.02 = 0.255 → ceil to 0.01 tick → 0.26
    expect(marketCapPrice(0.25, 0.02, '0.01')).toBeCloseTo(0.26, 6)
  })
  it('never returns >= 1', () => {
    expect(marketCapPrice(0.99, 0.05, '0.01')).toBeLessThan(1)
  })
})

describe('makerOrTaker', () => {
  it('market order is always taker', () => {
    expect(makerOrTaker('MARKET', 0.25, { bestBid: 0.23, bestAsk: 0.25 })).toBe('taker')
  })
  it('limit BUY below best ask rests on the book → maker', () => {
    expect(makerOrTaker('LIMIT', 0.24, { bestBid: 0.23, bestAsk: 0.25 })).toBe('maker')
  })
  it('limit BUY at/above best ask crosses → taker', () => {
    expect(makerOrTaker('LIMIT', 0.25, { bestBid: 0.23, bestAsk: 0.25 })).toBe('taker')
    expect(makerOrTaker('LIMIT', 0.30, { bestBid: 0.23, bestAsk: 0.25 })).toBe('taker')
  })
  it('maker when book ask is unknown (cannot cross what we cannot see)', () => {
    expect(makerOrTaker('LIMIT', 0.24, { bestBid: null, bestAsk: null })).toBe('maker')
  })
})
