import { describe, expect, it } from 'vitest'
import { MARKET_CACHE_LIMITS, validateMarketCacheInput } from './index'

describe('validateMarketCacheInput', () => {
  const validMarket = { id: 'm1', question: 'Will X?', embeddingB64: 'AAAA' }

  it('accepts a well-formed blob', () => {
    const r = validateMarketCacheInput({ model: 'Xenova/all-MiniLM-L12-v2', builtAt: 1700000000000, markets: [validMarket] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.blob.markets).toHaveLength(1)
  })

  it('rejects a non-object body', () => {
    expect(validateMarketCacheInput(null)).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput('nope')).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a missing or empty model string', () => {
    expect(validateMarketCacheInput({ builtAt: 1, markets: [validMarket] })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: '', builtAt: 1, markets: [validMarket] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a missing or non-finite builtAt', () => {
    expect(validateMarketCacheInput({ model: 'm', markets: [validMarket] })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: 'm', builtAt: NaN, markets: [validMarket] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects when markets is missing, not an array, or empty', () => {
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1 })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets: 'x' })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets: [] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects more than maxMarkets entries', () => {
    const markets = Array.from({ length: MARKET_CACHE_LIMITS.maxMarkets + 1 }, (_, i) => ({ ...validMarket, id: String(i) }))
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a market entry missing id, question, or embeddingB64', () => {
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets: [{ question: 'q', embeddingB64: 'A' }] })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets: [{ id: '1', embeddingB64: 'A' }] })).toMatchObject({ ok: false, status: 400 })
    expect(validateMarketCacheInput({ model: 'm', builtAt: 1, markets: [{ id: '1', question: 'q' }] })).toMatchObject({ ok: false, status: 400 })
  })
})
