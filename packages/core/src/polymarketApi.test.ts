import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTick } from './polymarketApi'
import { fetchOrderbookJson, fetchMarketById, fetchActiveMarkets, searchMarkets, CACHE_SLICES } from './polymarketApi'

describe('normalizeTick', () => {
  it('accepts the two CLOB-canonical tick sizes', () => {
    expect(normalizeTick('0.01')).toBe('0.01')
    expect(normalizeTick('0.001')).toBe('0.001')
  })

  it('accepts numeric input from Gamma', () => {
    expect(normalizeTick(0.01)).toBe('0.01')
    expect(normalizeTick(0.001)).toBe('0.001')
  })

  it('strips trailing zeros so the string round-trips cleanly', () => {
    expect(normalizeTick(0.1)).toBe('0.1')
    expect(normalizeTick('0.0100')).toBe('0.01')
  })

  it('rejects out-of-band values (caller falls back to negRisk default)', () => {
    expect(normalizeTick(0)).toBeUndefined()
    expect(normalizeTick(-0.01)).toBeUndefined()
    expect(normalizeTick(1)).toBeUndefined()
    expect(normalizeTick(2)).toBeUndefined()
    expect(normalizeTick(NaN)).toBeUndefined()
    expect(normalizeTick(Infinity)).toBeUndefined()
  })

  it('returns undefined for missing or unparseable input', () => {
    expect(normalizeTick(undefined)).toBeUndefined()
    expect(normalizeTick('')).toBeUndefined()
    expect(normalizeTick('not a number')).toBeUndefined()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOrderbookJson', () => {
  it('fetches the worker /orderbook proxy with the token id and auth header', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ asks: [], bids: [] }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const book = await fetchOrderbookJson('tok-1', 'https://worker.example', 'secret')
    expect(book).toEqual({ asks: [], bids: [] })
    const [url, init] = spy.mock.calls[0]
    expect(url).toContain('/orderbook?token_id=tok-1')
    expect((init.headers as Record<string, string>)['X-Actually-Auth']).toBe('secret')
  })

  it('returns an empty book on a non-ok response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const book = await fetchOrderbookJson('tok-1', 'https://worker.example', 'secret')
    expect(book).toEqual({ asks: [], bids: [] })
  })
})

describe('fetchMarketById', () => {
  const rawMarket = {
    id: 'm42',
    slug: 'will-x',
    question: 'Will X?',
    outcomePrices: '["0.3","0.7"]',
    outcomes: '["Yes","No"]',
    volume: 10,
    liquidity: 5,
    active: true,
    closed: false,
    clobTokenIds: '["tok-yes","tok-no"]',
  }

  it('queries the worker /markets proxy filtered by id', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify([rawMarket]), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const market = await fetchMarketById('m42', 'https://worker.example', 'secret')
    expect(market?.id).toBe('m42')
    expect(market?.clobTokenIds).toEqual(['tok-yes', 'tok-no'])
    const [url] = spy.mock.calls[0]
    expect(String(url)).toContain('/markets?id=m42')
  })

  it('returns null when Gamma returns an empty array (unknown id)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    expect(await fetchMarketById('unknown', 'https://worker.example', 'secret')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 500 })))
    expect(await fetchMarketById('m42', 'https://worker.example', 'secret')).toBeNull()
  })

  it('returns null when the record is missing required fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'm42' }]), { status: 200 })))
    expect(await fetchMarketById('m42', 'https://worker.example', 'secret')).toBeNull()
  })

  it('returns null on an id mismatch instead of silently falling back to the first result', async () => {
    // This sits directly on the order-placement path - trading whatever
    // Gamma happened to return first when no row actually matches would
    // sign an order against the wrong market.
    const otherMarket = { ...rawMarket, id: 'different-id' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([otherMarket]), { status: 200 })))
    expect(await fetchMarketById('m42', 'https://worker.example', 'secret')).toBeNull()
  })
})

// ---------------------------------------------------------------
// Market selection: which markets end up on the cache's fixed shelf
// ---------------------------------------------------------------
function gammaMarket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(over.id ?? Math.random()),
    question: 'Will X happen?',
    outcomePrices: '["0.5","0.5"]',
    outcomes: '["Yes","No"]',
    volumeNum: 1000,
    clobTokenIds: '["a","b"]',
    active: true,
    closed: false,
    ...over,
  }
}

/** Serve distinct markets per ordering so the blend is observable. */
function mockGamma(byOrder: Record<string, Record<string, unknown>[]>) {
  return vi.fn(async (url: string) => {
    const order = new URL(url, 'https://w').searchParams.get('order') ?? ''
    const offset = Number(new URL(url, 'https://w').searchParams.get('offset') ?? 0)
    const rows = byOrder[order] ?? []
    return { ok: true, status: 200, json: async () => rows.slice(offset, offset + 100) } as unknown as Response
  })
}

describe('fetchActiveMarkets - the cache must not be "biggest markets only"', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('blends all three orderings instead of paging lifetime volume alone', async () => {
    // The bug this replaces: a single `order=volumeNum` pass. Lifetime volume
    // ranks by ACCUMULATED interest, so markets opened under today's headline
    // - the ones a news reader wants - always lose to year-old ones. The live
    // cache had a $508,649 floor because of it.
    const fetchMock = mockGamma({
      volume24hr: [gammaMarket({ id: 'hot1' }), gammaMarket({ id: 'hot2' })],
      volumeNum: [gammaMarket({ id: 'big1' }), gammaMarket({ id: 'big2' })],
      startDate: [gammaMarket({ id: 'new1' })],
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchActiveMarkets('https://w', 's', 5)
    const ids = out.map((m) => m.id)
    expect(ids).toContain('hot1')
    expect(ids).toContain('big1')
    expect(ids).toContain('new1')
    const orders = fetchMock.mock.calls.map((c) => new URL(c[0] as string, 'https://w').searchParams.get('order'))
    for (const slice of CACHE_SLICES) expect(orders).toContain(slice.order)
  })

  it('drops per-game sports rows, which otherwise ARE the recency slice', async () => {
    // Measured 2026-08-21: 83% of the newest 800 markets are per-fixture
    // sports rows. Without this filter "recency" means a list of Dota games.
    vi.stubGlobal('fetch', mockGamma({
      volume24hr: [
        gammaMarket({ id: 'dota', question: 'Dota 2: Liquid vs Falcons - Game 1 Winner', gameId: '738778', sportsMarketType: 'child_moneyline' }),
        gammaMarket({ id: 'real', question: 'Will Trump be impeached?' }),
      ],
      volumeNum: [],
      startDate: [],
    }))
    const ids = (await fetchActiveMarkets('https://w', 's', 10)).map((m) => m.id)
    expect(ids).toContain('real')
    expect(ids).not.toContain('dota')
  })

  it('never returns the same market twice when orderings overlap', async () => {
    const shared = gammaMarket({ id: 'shared' })
    vi.stubGlobal('fetch', mockGamma({ volume24hr: [shared], volumeNum: [shared], startDate: [shared] }))
    const out = await fetchActiveMarkets('https://w', 's', 10)
    expect(out.filter((m) => m.id === 'shared')).toHaveLength(1)
  })

  it('backfills from lifetime volume when a slice comes up short', async () => {
    // Heavy filtering or Gamma's offset ceiling can starve a slice. That must
    // cost coverage of that KIND, not the size of the whole cache.
    vi.stubGlobal('fetch', mockGamma({
      volume24hr: [],
      volumeNum: Array.from({ length: 6 }, (_, i) => gammaMarket({ id: `big${i}` })),
      startDate: [],
    }))
    expect(await fetchActiveMarkets('https://w', 's', 5)).toHaveLength(5)
  })

  it('never exceeds the requested total', async () => {
    vi.stubGlobal('fetch', mockGamma({
      volume24hr: Array.from({ length: 40 }, (_, i) => gammaMarket({ id: `h${i}` })),
      volumeNum: Array.from({ length: 40 }, (_, i) => gammaMarket({ id: `b${i}` })),
      startDate: Array.from({ length: 40 }, (_, i) => gammaMarket({ id: `n${i}` })),
    }))
    expect((await fetchActiveMarkets('https://w', 's', 7))).toHaveLength(7)
  })
})

// ---------------------------------------------------------------
// Rate limits: what a 429 on a page does to the run
// ---------------------------------------------------------------

/** A rate-limited page. `headers` lets a test hand back a Retry-After. */
function rateLimited(body = '{"error":"rate_limited"}', headers: Record<string, string> = {}) {
  return {
    ok: false,
    status: 429,
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
  } as unknown as Response
}

function okPage(rows: Record<string, unknown>[]) {
  return { ok: true, status: 200, json: async () => rows } as unknown as Response
}

/** Runs every sleep instantly and records the delay it was asked for. */
function captureDelays(): number[] {
  const delays: number[] = []
  vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    fn()
    return 0
  }) as unknown as typeof setTimeout)
  return delays
}

describe('fetchActiveMarkets - a 429 is not a 5xx', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not retry a 429 by default, so a popup never hangs on one', async () => {
    // The extension pages /markets on its fallback path while the popup is
    // open. Waiting out a rate-limit window there is worse for the user than
    // falling straight through to on-device embedding.
    captureDelays()
    const fetchMock = vi.fn(async () => rateLimited())
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchActiveMarkets('https://w', 's', 5)).rejects.toThrow('fetch_markets_failed:429')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('carries the response body in the error, which is what names the source', async () => {
    // Our own Worker's limiter and Gamma's own throttle both arrive as a bare
    // 429. Only the body separates them, and the cron log is the only place
    // anyone will ever look.
    captureDelays()
    vi.stubGlobal('fetch', vi.fn(async () => rateLimited('{"error":"rate_limited"}')))
    await expect(fetchActiveMarkets('https://w', 's', 5)).rejects.toThrow(
      'fetch_markets_failed:429 {"error":"rate_limited"}',
    )
  })

  it('retries a 429 when the caller opts in, and uses the page it gets back', async () => {
    captureDelays()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return calls === 1 ? rateLimited() : okPage([gammaMarket({ id: 'after-429' })])
      }),
    )
    const out = await fetchActiveMarkets('https://w', 's', 1, { rateLimitRetryMs: 60_000 })
    expect(out.map((m) => m.id)).toContain('after-429')
    expect(calls).toBeGreaterThan(1)
  })

  it('waits the caller wait when no Retry-After is offered', async () => {
    const delays = captureDelays()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return calls === 1 ? rateLimited() : okPage([gammaMarket({ id: 'ok' })])
      }),
    )
    await fetchActiveMarkets('https://w', 's', 1, { rateLimitRetryMs: 60_000 })
    expect(delays).toContain(60_000)
  })

  it('prefers Retry-After over the caller wait, but caps what upstream can ask for', async () => {
    // Retry-After is upstream input: an absurd value would otherwise park an
    // unattended cron run for hours.
    const delays = captureDelays()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) return rateLimited('{"error":"rate_limited"}', { 'Retry-After': '5' })
        if (calls === 2) return rateLimited('{"error":"rate_limited"}', { 'Retry-After': '99999' })
        return okPage([gammaMarket({ id: 'ok' })])
      }),
    )
    await fetchActiveMarkets('https://w', 's', 1, { rateLimitRetryMs: 60_000 })
    expect(delays).toContain(5_000)
    expect(delays).toContain(120_000)
    expect(delays).not.toContain(60_000)
  })

  it('gives up after three rate-limited attempts instead of retrying forever', async () => {
    captureDelays()
    const fetchMock = vi.fn(async () => rateLimited())
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchActiveMarkets('https://w', 's', 5, { rateLimitRetryMs: 60_000 })).rejects.toThrow(
      'fetch_markets_failed:429',
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('still retries a 5xx on the short backoff, with no opt-in needed', async () => {
    // Regression guard: the 429 path was added to this same loop.
    const delays = captureDelays()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return calls === 1
          ? ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'upstream' } as unknown as Response)
          : okPage([gammaMarket({ id: 'after-503' })])
      }),
    )
    const out = await fetchActiveMarkets('https://w', 's', 1)
    expect(out.map((m) => m.id)).toContain('after-503')
    expect(delays).toContain(400)
  })
})

describe('searchMarkets - the long-tail escape hatch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('drops resolved markets - a closed market is not something to act on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [gammaMarket({ id: 'open' }), gammaMarket({ id: 'done', closed: true })],
    } as unknown as Response)))
    const ids = (await searchMarkets('https://w', 's', 'trump guard')).map((m) => m.id)
    expect(ids).toEqual(['open'])
  })

  it('surfaces an upstream failure rather than silently reporting no markets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => [] } as unknown as Response)))
    await expect(searchMarkets('https://w', 's', 'x')).rejects.toThrow(/search_markets_failed:502/)
  })
})
