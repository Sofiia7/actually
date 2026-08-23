import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MODEL_ID, type MarketCacheBlob, type PolyMarket } from '@actually/core'
import { clearMarketCache, getCacheStatus, getMarketCache, refreshMarketCache } from './cache'

function market(id: string, question = `Will ${id} happen?`): PolyMarket {
  return {
    id,
    slug: `market-${id}`,
    question,
    outcomePrices: '["0.5","0.5"]',
    outcomes: '["Yes","No"]',
    volume: 1000,
    liquidity: 500,
    active: true,
    closed: false,
    clobTokenIds: ['a', 'b'],
  }
}

function blob(markets: PolyMarket[], model = LOCAL_MODEL_ID): MarketCacheBlob {
  return {
    model,
    builtAt: Date.now(),
    markets: markets.map((m) => ({ ...m, embeddingB64: 'AAAA', questionHash: `hash-${m.id}`, cachedAt: Date.now() })),
  }
}

describe('refreshMarketCache - local provider (precomputed Worker cache)', () => {
  beforeEach(async () => {
    await clearMarketCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('downloads the Worker\'s precomputed blob instead of embedding on-device', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe('https://w.example/market-cache')
      return new Response(JSON.stringify(blob([market('m1'), market('m2')])), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0]
    expect((init?.headers as Record<string, string>)['X-Actually-Auth']).toBe('secret')
    expect(result).toEqual({ added: 2, reused: 0, removed: 0 })
    const cached = await getMarketCache()
    expect(cached.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('computes added/reused/removed against whatever was cached before, regardless of its source', async () => {
    await clearMarketCache()
    // Seed as if a previous refresh had cached m1 and m_old.
    const seedFetch = vi.fn(async () => new Response(JSON.stringify(blob([market('m1'), market('m_old')])), { status: 200 }))
    vi.stubGlobal('fetch', seedFetch)
    await refreshMarketCache('local', 'https://w.example', 'secret')

    const nextFetch = vi.fn(async () => new Response(JSON.stringify(blob([market('m1'), market('m2')])), { status: 200 }))
    vi.stubGlobal('fetch', nextFetch)
    const result = await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(result).toEqual({ added: 1, reused: 1, removed: 1 }) // m2 added, m1 reused, m_old removed
    const cached = await getMarketCache()
    expect(cached.map((m) => m.id).sort()).toEqual(['m1', 'm2'])
  })

  it('rejects a blob whose model does not match the local model and falls back to on-device embedding', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/market-cache')) {
        return new Response(JSON.stringify(blob([market('m1')], 'some-other-model')), { status: 200 })
      }
      // Fallback path: fetchActiveMarkets hits /markets.
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await refreshMarketCache('local', 'https://w.example', 'secret')

    // Fell through to the embedding-based path (no markets returned there → nothing added).
    expect(result).toEqual({ added: 0, reused: 0, removed: 0 })
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(calledUrls.some((u) => u.includes('/market-cache'))).toBe(true)
    expect(calledUrls.some((u) => u.includes('/markets'))).toBe(true)
  })

  it('falls back to on-device embedding if the precomputed cache is unreachable', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/market-cache')) {
        return new Response('server error', { status: 500 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(result).toEqual({ added: 0, reused: 0, removed: 0 })
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(calledUrls.some((u) => u.includes('/markets'))).toBe(true)
  })

  // The blob is ~7 MB. One dropped connection used to cost the user minutes:
  // the fallback embeds hundreds of markets through WASM on their device, and
  // it needs the network too, so a blip that would have healed on a second
  // try surfaced as "Couldn't load markets: TypeError: Failed to fetch".
  it('retries a dropped connection instead of falling back to on-device embedding', async () => {
    let attempts = 0
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).endsWith('/market-cache')) {
        attempts++
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify(blob([market('m1')])), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(result.added).toBe(1)
    expect(attempts).toBe(2)
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(calledUrls.some((u) => u.includes('/markets'))).toBe(false)
  })

  it('does not retry a rejected secret - a wrong key stays wrong', async () => {
    let attempts = 0
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).endsWith('/market-cache')) {
        attempts++
        return new Response('unauthorized', { status: 401 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(attempts).toBe(1)
  })

  it('does not retry a model mismatch - a second identical request cannot answer differently', async () => {
    let attempts = 0
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).endsWith('/market-cache')) {
        attempts++
        return new Response(JSON.stringify(blob([market('m1')], 'Xenova/some-other-model')), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await refreshMarketCache('local', 'https://w.example', 'secret')

    expect(attempts).toBe(1)
  })

  it('does not touch the precomputed endpoint at all for the openai provider', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(String(url)).not.toContain('/market-cache')
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await refreshMarketCache('openai', 'https://w.example', 'secret')
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe('getCacheStatus / getMarketCache', () => {
  beforeEach(async () => {
    await clearMarketCache()
  })

  it('reports an empty cache before any refresh', async () => {
    const status = await getCacheStatus()
    expect(status.count).toBe(0)
  })
})
