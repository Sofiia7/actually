import { describe, expect, it } from 'vitest'
import { getMarket } from './getMarket'
import type { CachedMarket } from '@actually/core'
import { floatArrayToB64 } from '@actually/core'

function fakeMarket(over: Partial<CachedMarket>): CachedMarket {
  return {
    id: over.id ?? 'm1',
    slug: over.slug ?? 'slug',
    question: over.question ?? 'Will X happen?',
    outcomePrices: over.outcomePrices ?? '["0.5","0.5"]',
    outcomes: over.outcomes ?? '["Yes","No"]',
    volume: over.volume ?? 0,
    liquidity: over.liquidity ?? 0,
    active: true,
    closed: false,
    clobTokenIds: over.clobTokenIds ?? ['tok-yes', 'tok-no'],
    embeddingB64: floatArrayToB64(new Float32Array([1, 0, 0])),
    questionHash: 'hash',
    cachedAt: Date.now(),
    ...over,
  }
}

describe('getMarket', () => {
  it('returns found=false when no market matches the id', async () => {
    const store = { getMarkets: async () => [fakeMarket({ id: 'other' })] }
    const result = await getMarket(
      { store, fetchLivePrice: async () => null, fetchOrderbook: async () => ({ asks: [], bids: [] }) },
      { marketId: 'm1' },
    )
    expect(result.found).toBe(false)
  })

  it('returns market details, live price, and an orderbook snapshot', async () => {
    const mkt = fakeMarket({ id: 'm1', outcomePrices: '["0.3","0.7"]' })
    const store = { getMarkets: async () => [mkt] }
    const result = await getMarket(
      {
        store,
        fetchLivePrice: async () => 0.31,
        fetchOrderbook: async () => ({ asks: [{ price: '0.32', size: '10' }], bids: [{ price: '0.30', size: '10' }] }),
      },
      { marketId: 'm1' },
    )
    expect(result.found).toBe(true)
    expect(result.market?.probabilityYes).toBeCloseTo(0.3, 6)
    expect(result.livePrice).toBeCloseTo(0.31, 6)
    expect(result.orderbook?.bestAsk).toBeCloseTo(0.32, 6)
    expect(result.orderbook?.bestBid).toBeCloseTo(0.30, 6)
  })
})
