import { describe, expect, it } from 'vitest'
import { buildBlob } from './buildBlob'
import type { PolyMarket } from '@actually/core'

function market(over: Partial<PolyMarket>): PolyMarket {
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
    ...over,
  }
}

describe('buildBlob', () => {
  it('embeds every market question and stamps the model + builtAt', async () => {
    const markets = [market({ id: 'm1' }), market({ id: 'm2', question: 'Will Y happen?' })]
    const embed = async (text: string) => new Float32Array([text.length, 0, 0])
    const blob = await buildBlob(markets, embed, 'test-model', 123)
    expect(blob.model).toBe('test-model')
    expect(blob.builtAt).toBe(123)
    expect(blob.markets).toHaveLength(2)
    expect(blob.markets[0].id).toBe('m1')
    expect(blob.markets[0].embeddingB64).toBeTruthy()
    expect(blob.markets[0].questionHash).toBeTruthy()
  })

  it('drops noise markets before embedding', async () => {
    const markets = [
      market({ id: 'keep', question: 'Will Iran enrich uranium by July?' }),
      market({ id: 'noise', question: 'Will Trump say "tremendous" during the speech?' }),
    ]
    let embedCalls = 0
    const embed = async () => {
      embedCalls++
      return new Float32Array([1, 0, 0])
    }
    const blob = await buildBlob(markets, embed, 'test-model', 1)
    expect(blob.markets.map((m) => m.id)).toEqual(['keep'])
    expect(embedCalls).toBe(1)
  })

  it('drops non-binary (categorical) markets before embedding', async () => {
    const markets = [
      market({ id: 'binary', outcomes: '["Yes","No"]' }),
      market({ id: 'categorical', outcomes: '["A","B","C"]' }),
    ]
    const embed = async () => new Float32Array([1, 0, 0])
    const blob = await buildBlob(markets, embed, 'test-model', 1)
    expect(blob.markets.map((m) => m.id)).toEqual(['binary'])
  })

  it('returns an empty blob with zero embed calls when given no markets', async () => {
    let embedCalls = 0
    const embed = async () => {
      embedCalls++
      return new Float32Array([1, 0, 0])
    }
    const blob = await buildBlob([], embed, 'test-model', 42)
    expect(blob).toEqual({ model: 'test-model', builtAt: 42, markets: [] })
    expect(embedCalls).toBe(0)
  })

  it('drops a market that is both noise AND categorical (filters compose, not just one masking the other)', async () => {
    const markets = [
      market({ id: 'keep', question: 'Will Iran enrich uranium by July?', outcomes: '["Yes","No"]' }),
      market({
        id: 'noise-and-categorical',
        question: 'Will Trump say "tremendous" during the speech?',
        outcomes: '["A","B","C"]',
      }),
    ]
    let embedCalls = 0
    const embed = async () => {
      embedCalls++
      return new Float32Array([1, 0, 0])
    }
    const blob = await buildBlob(markets, embed, 'test-model', 1)
    expect(blob.markets.map((m) => m.id)).toEqual(['keep'])
    expect(embedCalls).toBe(1)
  })
})
