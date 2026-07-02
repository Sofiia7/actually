import { describe, expect, it } from 'vitest'
import { checkNews } from './checkNews'
import type { CachedMarket } from '@actually/core'
import { floatArrayToB64 } from '@actually/core'

function fakeMarket(over: Partial<CachedMarket> & { vec: number[] }): CachedMarket {
  const { vec, ...rest } = over
  return {
    id: rest.id ?? 'm1',
    slug: rest.slug ?? 'slug',
    question: rest.question ?? 'Will X happen?',
    outcomePrices: rest.outcomePrices ?? '["0.5","0.5"]',
    outcomes: rest.outcomes ?? '["Yes","No"]',
    volume: rest.volume ?? 0,
    liquidity: rest.liquidity ?? 0,
    active: true,
    closed: false,
    clobTokenIds: rest.clobTokenIds ?? ['tok-yes', 'tok-no'],
    embeddingB64: floatArrayToB64(new Float32Array(vec)),
    questionHash: 'hash',
    cachedAt: Date.now(),
    ...rest,
  }
}

const thresholds = { confidenceThreshold: 0.8, lowConfidenceFloor: 0.5 }

describe('checkNews', () => {
  it('returns hasMarket=false with a reason when the text is empty', async () => {
    const store = { getMarkets: async () => [] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await checkNews({ store, embedder, thresholds }, { text: '   ' })
    expect(result.hasMarket).toBe(false)
    expect(result.reason).toBe('empty_text')
  })

  it('returns the objective market probability, not an invented number', async () => {
    const mkt = fakeMarket({
      id: 'm1',
      question: 'Will Iran enrich uranium past 60% by July?',
      outcomePrices: '["0.12","0.88"]',
      vec: [1, 0, 0],
    })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await checkNews({ store, embedder, thresholds }, { text: 'Iran enriches uranium past 60%, officials warn' })
    expect(result.hasMarket).toBe(true)
    expect(result.marketProbabilityYes).toBeCloseTo(0.12, 6)
    expect(result.market?.marketId).toBe('m1')
    expect(result.market?.clobTokenIds).toEqual(['tok-yes', 'tok-no'])
  })

  it('returns hasMarket=false when nothing clears the floor', async () => {
    const mkt = fakeMarket({ vec: [0, 1, 0] })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await checkNews({ store, embedder, thresholds }, { text: 'completely unrelated text' })
    expect(result.hasMarket).toBe(false)
  })
})
