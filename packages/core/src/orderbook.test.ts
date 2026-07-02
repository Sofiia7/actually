import { describe, expect, it } from 'vitest'
import { parseOrderbook } from './orderbook'

describe('parseOrderbook', () => {
  it('computes best bid/ask and spread from raw book levels', () => {
    const book = {
      asks: [{ price: '0.55', size: '100' }, { price: '0.60', size: '50' }],
      bids: [{ price: '0.50', size: '200' }, { price: '0.45', size: '100' }],
    }
    const snap = parseOrderbook(book)
    expect(snap.bestAsk).toBeCloseTo(0.55, 6)
    expect(snap.bestBid).toBeCloseTo(0.50, 6)
    expect(snap.spread).toBeCloseTo(0.05, 6)
  })

  it('returns nulls for an empty book', () => {
    const snap = parseOrderbook({ asks: [], bids: [] })
    expect(snap.bestAsk).toBeNull()
    expect(snap.bestBid).toBeNull()
    expect(snap.spread).toBeNull()
  })

  it('estimateBuy walks the book depth for a market order', () => {
    const book = {
      asks: [{ price: '0.50', size: '10' }, { price: '0.55', size: '10' }],
      bids: [],
    }
    const snap = parseOrderbook(book)
    const est = snap.estimateBuy(15)
    expect(est?.effectivePrice).toBeCloseTo((10 * 0.5 + 5 * 0.55) / 15, 6)
  })

  it('estimateBuy flags insufficient depth with 100% slippage', () => {
    const book = { asks: [{ price: '0.50', size: '5' }], bids: [] }
    const snap = parseOrderbook(book)
    const est = snap.estimateBuy(100)
    expect(est?.slippage).toBe(1)
    expect(est?.effectivePrice).toBeCloseTo(0.50, 6)
  })

  it('filters out levels with non-numeric price/size instead of propagating NaN', () => {
    const book = {
      asks: [{ price: 'not-a-number', size: '100' }, { price: '0.60', size: '50' }],
      bids: [{ price: '0.50', size: '200' }, { price: '0.45', size: 'garbage' }],
    }
    const snap = parseOrderbook(book)
    expect(snap.bestAsk).toBeCloseTo(0.60, 6)
    expect(snap.bestBid).toBeCloseTo(0.50, 6)
    expect(snap.spread).toBeCloseTo(0.10, 6)
    expect(Number.isNaN(snap.bestAsk)).toBe(false)
    expect(Number.isNaN(snap.bestBid)).toBe(false)
  })
})
