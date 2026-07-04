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

  it('degrades gracefully when the market has no YES token id', async () => {
    const mkt = fakeMarket({ id: 'm1', clobTokenIds: [] })
    const store = { getMarkets: async () => [mkt] }
    let fetchLivePriceCalled = false
    let fetchOrderbookCalled = false
    const result = await getMarket(
      {
        store,
        fetchLivePrice: async () => {
          fetchLivePriceCalled = true
          return 0.5
        },
        fetchOrderbook: async () => {
          fetchOrderbookCalled = true
          return { asks: [{ price: '0.5', size: '1' }], bids: [{ price: '0.4', size: '1' }] }
        },
      },
      { marketId: 'm1' },
    )
    expect(result.found).toBe(true)
    expect(result.livePrice).toBeNull()
    expect(result.orderbook).toEqual({ bestBid: null, bestAsk: null, spread: null })
    expect(fetchLivePriceCalled).toBe(false)
    expect(fetchOrderbookCalled).toBe(false)
  })

  it('reports probabilityYes as 0 instead of throwing when outcomePrices is malformed', async () => {
    const mkt = fakeMarket({ id: 'm1', outcomePrices: 'not json' })
    const store = { getMarkets: async () => [mkt] }
    const result = await getMarket(
      { store, fetchLivePrice: async () => null, fetchOrderbook: async () => ({ asks: [], bids: [] }) },
      { marketId: 'm1' },
    )
    expect(result.found).toBe(true)
    expect(result.market?.probabilityYes).toBe(0)
  })

  it('falls back to fetchMarketById when the market is outside the cache', async () => {
    const store = { getMarkets: async () => [fakeMarket({ id: 'other' })] }
    let fallbackCalledWith: string | undefined
    const result = await getMarket(
      {
        store,
        fetchLivePrice: async () => 0.4,
        fetchOrderbook: async () => ({ asks: [], bids: [] }),
        fetchMarketById: async (id) => {
          fallbackCalledWith = id
          return {
            id: 'm-uncached',
            slug: 'uncached',
            question: 'Uncached market?',
            outcomePrices: '["0.4","0.6"]',
            outcomes: '["Yes","No"]',
            volume: 1,
            liquidity: 1,
            active: true,
            closed: false,
            clobTokenIds: ['tok-yes-u', 'tok-no-u'],
          }
        },
      },
      { marketId: 'm-uncached' },
    )
    expect(fallbackCalledWith).toBe('m-uncached')
    expect(result.found).toBe(true)
    expect(result.market?.marketId).toBe('m-uncached')
  })

  it('stays found=false when the fallback also misses', async () => {
    const store = { getMarkets: async () => [] }
    const result = await getMarket(
      {
        store,
        fetchLivePrice: async () => null,
        fetchOrderbook: async () => ({ asks: [], bids: [] }),
        fetchMarketById: async () => null,
      },
      { marketId: 'unknown' },
    )
    expect(result.found).toBe(false)
  })

  it('does not call the fallback when the cache already has the market', async () => {
    const mkt = fakeMarket({ id: 'm1' })
    const store = { getMarkets: async () => [mkt] }
    let fallbackCalled = false
    await getMarket(
      {
        store,
        fetchLivePrice: async () => null,
        fetchOrderbook: async () => ({ asks: [], bids: [] }),
        fetchMarketById: async () => {
          fallbackCalled = true
          return null
        },
      },
      { marketId: 'm1' },
    )
    expect(fallbackCalled).toBe(false)
  })
})
