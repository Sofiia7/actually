import { describe, expect, it } from 'vitest'
import { resolveMarket } from './resolveMarket'
import type { CachedMarket } from '@actually/core'

function market(over: Partial<CachedMarket> = {}): CachedMarket {
  return {
    id: 'm1',
    slug: 's',
    question: 'Will X?',
    outcomePrices: '["0.5","0.5"]',
    outcomes: '["Yes","No"]',
    volume: 1,
    liquidity: 1,
    active: true,
    closed: false,
    clobTokenIds: ['tok-yes', 'tok-no'],
    embeddingB64: '',
    questionHash: '',
    cachedAt: 0,
    ...over,
  }
}

describe('resolveMarket', () => {
  it('returns the cached market without calling the fallback', async () => {
    let fallbackCalled = false
    const result = await resolveMarket(
      {
        store: { getMarkets: async () => [market({ id: 'm1' })] },
        fetchMarketById: async () => {
          fallbackCalled = true
          return null
        },
      },
      'm1',
    )
    expect(result?.id).toBe('m1')
    expect(fallbackCalled).toBe(false)
  })

  it('falls back to fetchMarketById when the cache misses', async () => {
    const result = await resolveMarket(
      {
        store: { getMarkets: async () => [] },
        fetchMarketById: async (id) => market({ id }),
      },
      'm2',
    )
    expect(result?.id).toBe('m2')
  })

  it('returns null when both the cache and the fallback miss', async () => {
    const result = await resolveMarket(
      { store: { getMarkets: async () => [] }, fetchMarketById: async () => null },
      'unknown',
    )
    expect(result).toBeNull()
  })
})
