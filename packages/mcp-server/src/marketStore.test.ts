import { describe, expect, it, vi, afterEach } from 'vitest'
import { WorkerMarketStore } from './marketStore'

afterEach(() => {
  vi.unstubAllGlobals()
})

const validBlob = {
  model: 'Xenova/all-MiniLM-L12-v2',
  builtAt: 1700000000000,
  markets: [{ id: 'm1', slug: 's', question: 'Will X?', outcomePrices: '["0.5","0.5"]', outcomes: '["Yes","No"]', volume: 0, liquidity: 0, active: true, closed: false, clobTokenIds: [], embeddingB64: 'AAAA', questionHash: 'h', cachedAt: 1 }],
}

describe('WorkerMarketStore', () => {
  it('fetches and returns the markets array on the happy path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(validBlob), { status: 200 })))
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    const markets = await store.getMarkets()
    expect(markets).toHaveLength(1)
    expect(markets[0].id).toBe('m1')
  })

  it('throws a clear error on a model mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...validBlob, model: 'some-other-model' }), { status: 200 })))
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    await expect(store.getMarkets()).rejects.toThrow(/model mismatch/i)
  })

  it('throws when the cache has not been populated (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_populated' }), { status: 404 })))
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    await expect(store.getMarkets()).rejects.toThrow(/not_populated|404/)
  })

  it('caches the result in-memory for the TTL and does not refetch', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(validBlob), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    await store.getMarkets()
    await store.getMarkets()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throws a clear error when the response body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    await expect(store.getMarkets()).rejects.toThrow(/not valid JSON/i)
  })

  it('dedupes concurrent calls during a cache miss into a single fetch', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(validBlob), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const store = new WorkerMarketStore('https://worker.example', 'secret', 'Xenova/all-MiniLM-L12-v2')
    const [a, b] = await Promise.all([store.getMarkets(), store.getMarkets()])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})
