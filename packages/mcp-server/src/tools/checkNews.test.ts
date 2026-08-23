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

  it('sets lowConfidence=true when the top match clears the floor but not the threshold', async () => {
    // [0.6, 0.8, 0] is a unit vector; cosine against [1,0,0] is exactly 0.6 -
    // above the 0.5 floor but below the 0.8 threshold (same fixture used in
    // @actually/core's matcher.test.ts to establish this exact boundary).
    const mkt = fakeMarket({ vec: [0.6, 0.8, 0] })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await checkNews({ store, embedder, thresholds }, { text: 'some news text' })
    expect(result.hasMarket).toBe(true)
    expect(result.lowConfidence).toBe(true)
  })

  it('caps alternatives at 3 even though findMatch itself allows up to 4', async () => {
    const store = {
      getMarkets: async () => [
        fakeMarket({ id: 'top', question: 'Will X happen?', vec: [1, 0, 0] }),
        fakeMarket({ id: 'alt1', question: 'Will A happen?', vec: [0.9, 0.1, 0] }),
        fakeMarket({ id: 'alt2', question: 'Will B happen?', vec: [0.85, 0.15, 0] }),
        fakeMarket({ id: 'alt3', question: 'Will C happen?', vec: [0.8, 0.2, 0] }),
        fakeMarket({ id: 'alt4', question: 'Will D happen?', vec: [0.75, 0.25, 0] }),
      ],
    }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await checkNews({ store, embedder, thresholds }, { text: 'Will X happen?' })
    expect(result.hasMarket).toBe(true)
    expect(result.alternatives).toHaveLength(3)
  })
})

describe('checkNews - a miss has to be actionable for an agent', () => {
  const embedder = { embed: async () => new Float32Array([1, 0, 0]) }

  it('names what it came closest to, and how many it compared', async () => {
    // A bare `no_market_above_floor` cannot tell an agent whether Polymarket
    // has nothing on the subject or the cached shelf simply does not reach
    // that far. Those call for opposite next moves.
    const out = await checkNews(
      { store: { getMarkets: async () => [fakeMarket({ id: 'far', question: 'Will the Lakers win?', vec: [0, 1, 0] })] }, embedder, thresholds },
      { text: 'Iran enriches uranium past 60%' },
    )
    expect(out.hasMarket).toBe(false)
    expect(out.reason).toBe('no_market_above_floor')
    expect(out.nearest?.question).toBe('Will the Lakers win?')
    expect(out.marketsCompared).toBe(1)
  })

  it('reaches the long tail when the operator opted in', async () => {
    const { embeddingB64: _e, questionHash: _h, cachedAt: _c, ...tail } =
      fakeMarket({ id: 'tail', question: 'Will Iran enrich uranium?', vec: [1, 0, 0] })
    const out = await checkNews(
      {
        store: { getMarkets: async () => [fakeMarket({ id: 'far', question: 'Will the Lakers win?', vec: [0, 1, 0] })] },
        embedder,
        thresholds,
        searchFallback: async () => [tail],
      },
      { text: 'Iran enriches uranium past 60%' },
    )
    expect(out.hasMarket).toBe(true)
    expect(out.market?.question).toBe('Will Iran enrich uranium?')
  })

  it('does not search when no fallback was supplied', async () => {
    const out = await checkNews(
      { store: { getMarkets: async () => [] }, embedder, thresholds },
      { text: 'anything' },
    )
    expect(out.hasMarket).toBe(false)
    expect(out.marketsCompared).toBe(0)
  })
})
