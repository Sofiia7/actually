import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { MARKET_CACHE_LIMITS } from './index'

// We exercise the Worker by calling its `fetch` handler directly with a fake
// `env` (a Map-backed KV) and a stubbed global `fetch` for the routes that
// proxy upstream. This covers the same perimeter as Miniflare (auth, CORS,
// geo, rate-limit, input validation, upstream host) without the workerd binary.

const EXT = 'abcdefghijklmnopabcdefghijklmnop' // 32-char extension id
const ORIGIN = `chrome-extension://${EXT}`

function fakeKV() {
  const m = new Map<string, string>()
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
  } as unknown as KVNamespace
}

/**
 * Fake RateLimiterDO namespace. Models the two properties that matter for
 * the atomicity regression test below:
 *
 * 1. Real Durable Object storage reads/writes are genuine async I/O with
 *    real latency — the same latency that made the OLD KV-based rateLimit()
 *    racy (env.RATE_LIMITS.get() then .put() were two real network round
 *    trips, with a real yield gap between them). `handleIncrement` below
 *    inserts an explicit `await` between its read and its write to
 *    reproduce that same yield gap, instead of silently completing
 *    synchronously (which would make this fake "accidentally atomic" for
 *    reasons that have nothing to do with the actual fix).
 * 2. Cloudflare's real guarantee — a single Durable Object instance
 *    processes one request to completion before starting the next — is
 *    modeled with a promise-chain queue keyed by instance name. That queue
 *    is the thing actually being tested: remove it and the yield gap in (1)
 *    lets concurrent calls interleave and over-admit past the limit, the
 *    exact bug this Durable Object replaces KV to fix.
 */
function fakeRateLimiterDO() {
  const stores = new Map<string, { windowStart: number; count: number }>()
  const queues = new Map<string, Promise<unknown>>()

  async function handleIncrement(name: string, windowMs: number, limit: number, amount: number) {
    const now = Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    await Promise.resolve() // yield — models the storage read's I/O latency
    const existing = stores.get(name)
    const bucket = existing && existing.windowStart === windowStart ? existing : { windowStart, count: 0 }
    if (bucket.count + amount > limit) return { allowed: false, count: bucket.count }
    await Promise.resolve() // yield — models the storage write's I/O latency
    bucket.count += amount
    stores.set(name, bucket)
    return { allowed: true, count: bucket.count }
  }

  return {
    idFromName: (name: string) => ({ __name: name, toString: () => name }),
    get: (id: { __name: string }) => ({
      fetch: async (_url: string, init: { body: string }) => {
        const { windowMs, limit, amount } = JSON.parse(init.body) as {
          windowMs: number
          limit: number
          amount: number
        }
        const name = id.__name
        const prior = queues.get(name) ?? Promise.resolve()
        const turn = prior.then(() => handleIncrement(name, windowMs, limit, amount))
        queues.set(name, turn)
        const result = await turn
        return new Response(JSON.stringify(result))
      },
    }),
  } as unknown as DurableObjectNamespace
}

function baseEnv(over: Record<string, unknown> = {}) {
  return {
    WORKER_SHARED_SECRET: 'secret',
    ALLOWED_EXTENSION_ID: EXT,
    OPENAI_API_KEY: 'sk-test',
    RATE_LIMITER_DO: fakeRateLimiterDO(),
    MARKET_CACHE: fakeKV(),
    ...over,
  } as never
}

interface ReqOpts {
  method?: string
  auth?: string | null // null = omit
  origin?: string | null
  country?: string
  region?: string
  headers?: Record<string, string>
  body?: string
}

function req(path: string, o: ReqOpts = {}): Request {
  const h = new Headers(o.headers)
  if (o.origin !== null) h.set('Origin', o.origin ?? ORIGIN)
  if (o.auth !== null) h.set('X-Actually-Auth', o.auth ?? 'secret')
  if (o.country) h.set('CF-IPCountry', o.country)
  const request = new Request(`https://w.example${path}`, { method: o.method ?? 'GET', headers: h, body: o.body })
  // Region code is NOT a header Cloudflare sends to Workers — it only rides on
  // the runtime-attached `request.cf` object (IncomingRequestCfProperties).
  // Standard Request has no `cf` slot, so we attach one here the same way the
  // real Workers runtime does, to catch regressions like reading it as a header.
  if (o.region) {
    Object.defineProperty(request, 'cf', { value: { regionCode: o.region }, writable: true })
  }
  return request
}

const call = (path: string, env: never, o?: ReqOpts) => worker.fetch(req(path, o), env)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('health + auth', () => {
  it('/health needs no auth', async () => {
    const res = await call('/health', baseEnv(), { auth: null, origin: null })
    expect(res.status).toBe(200)
  })

  it('rejects a bad secret with 401', async () => {
    const res = await call('/geo', baseEnv(), { auth: 'wrong' })
    expect(res.status).toBe(401)
  })

  it('returns 503 when WORKER_SHARED_SECRET is unset (misconfigured)', async () => {
    const res = await call('/geo', baseEnv({ WORKER_SHARED_SECRET: undefined }))
    expect(res.status).toBe(503)
  })

  it('dev mode bypasses missing secret', async () => {
    const res = await call('/geo', baseEnv({ WORKER_SHARED_SECRET: undefined, WORKER_DEV_MODE: 'true' }), { country: 'RS' })
    expect(res.status).toBe(200)
  })

  it('returns 503 when RATE_LIMITER_DO is not bound in prod (fail-closed backstop)', async () => {
    const res = await call('/geo', baseEnv({ RATE_LIMITER_DO: undefined }), { country: 'RS' })
    expect(res.status).toBe(503)
    expect((await res.json() as { reason?: string }).reason).toBe('worker_misconfigured_no_rate_limiter')
  })

  it('dev mode bypasses missing RATE_LIMITER_DO', async () => {
    const res = await call('/geo', baseEnv({ RATE_LIMITER_DO: undefined, WORKER_DEV_MODE: 'true' }), { country: 'RS' })
    expect(res.status).toBe(200)
  })

  it('/health stays up even without RATE_LIMITER_DO (liveness must not depend on the backstop)', async () => {
    const res = await call('/health', baseEnv({ RATE_LIMITER_DO: undefined }), { auth: null, origin: null })
    expect(res.status).toBe(200)
  })

  it('rejects an origin not in the allow-list', async () => {
    const res = await call('/geo', baseEnv(), { origin: 'chrome-extension://someoneelse' })
    expect(res.status).toBe(401)
  })

  it('allows a request with no Origin header when the shared secret is valid (server-side clients)', async () => {
    // Origin is a browser-enforced signal: pages can't forge it, but any
    // non-browser attacker can trivially SET it — so rejecting its absence
    // (tried 2026-07-08, deployed 2026-07-14) stopped no real attacker while
    // breaking both legitimate server-side clients in prod: the market-cache
    // cron builder and the MCP server, neither of which is a browser. The
    // secret gates access; the DO rate limiter is the abuse backstop. A
    // PRESENT-but-wrong Origin (a foreign web page) is still rejected above.
    const res = await call('/geo', baseEnv(), { origin: null, country: 'RS' })
    expect(res.status).toBe(200)
  })

  it('allows /market-cache GET with no Origin (the MCP server and cache builder are not browsers)', async () => {
    const env = baseEnv()
    await (env as { MARKET_CACHE: KVNamespace }).MARKET_CACHE.put(
      'blob',
      JSON.stringify({ model: 'Xenova/all-MiniLM-L12-v2', builtAt: 1, markets: [] }),
    )
    const res = await call('/market-cache', env, { origin: null })
    expect(res.status).toBe(200)
  })
})

describe('CORS fail-closed', () => {
  it('OPTIONS echoes the allowed origin', async () => {
    const res = await call('/geo', baseEnv(), { method: 'OPTIONS' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
  })

  it('OPTIONS returns the invalid sentinel origin when no extension id configured', async () => {
    const res = await call('/geo', baseEnv({ ALLOWED_EXTENSION_ID: undefined }), { method: 'OPTIONS' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toContain('__actually_misconfigured__')
  })
})

describe('/geo', () => {
  it('blocks a confirmed restricted country (US)', async () => {
    const res = await call('/geo', baseEnv(), { country: 'US' })
    const body = (await res.json()) as { country: string; blocked: boolean }
    expect(body).toMatchObject({ country: 'US', blocked: true })
  })

  it('allows an unrestricted country (RS)', async () => {
    const res = await call('/geo', baseEnv(), { country: 'RS' })
    expect((await res.json() as { blocked: boolean }).blocked).toBe(false)
  })

  it('blocks comprehensively OFAC-sanctioned jurisdictions (IR, KP, CU, SY)', async () => {
    for (const country of ['IR', 'KP', 'CU', 'SY']) {
      const res = await call('/geo', baseEnv(), { country })
      expect((await res.json() as { blocked: boolean }).blocked).toBe(true)
    }
  })

  it('blocks Ontario (CA + ON region)', async () => {
    const res = await call('/geo', baseEnv(), { country: 'CA', region: 'ON' })
    expect((await res.json() as { blocked: boolean }).blocked).toBe(true)
  })

  it('does not block the rest of Canada (CA + QC)', async () => {
    const res = await call('/geo', baseEnv(), { country: 'CA', region: 'QC' })
    expect((await res.json() as { blocked: boolean }).blocked).toBe(false)
  })

  it('honors EXTRA_BLOCKED_COUNTRIES from env', async () => {
    const res = await call('/geo', baseEnv({ EXTRA_BLOCKED_COUNTRIES: 'DE,NL' }), { country: 'DE' })
    expect((await res.json() as { blocked: boolean }).blocked).toBe(true)
  })

  it('regression: a CF-Region-Code HTTP header (not real Cloudflare behavior) must NOT be trusted', async () => {
    // Cloudflare never sends region as a request header to Workers — only via
    // request.cf.regionCode. This guards against re-introducing the header-based
    // read, which would silently never block Ontario in production.
    const res = await call('/geo', baseEnv(), {
      country: 'CA',
      headers: { 'CF-Region-Code': 'ON' },
    })
    expect((await res.json() as { blocked: boolean }).blocked).toBe(false)
  })

  it('reports Tor exit traffic (T1) as no confirmed country, not as an allowed one', async () => {
    // Cloudflare sends CF-IPCountry: T1 for Tor. Passing it through as-is
    // would read as a confirmed non-blocked country to the client and skip
    // the fail-closed posture entirely.
    const res = await call('/geo', baseEnv(), { country: 'T1' })
    const body = (await res.json()) as { country: string; blocked: boolean }
    expect(body.country).toBe('')
    expect(body.blocked).toBe(false) // not "blocked" either — the client treats empty country as unknown/fail-closed
  })

  it('reports an ungeolocatable request (XX) as no confirmed country', async () => {
    const res = await call('/geo', baseEnv(), { country: 'XX' })
    const body = (await res.json()) as { country: string }
    expect(body.country).toBe('')
  })
})

describe('global per-IP rate limit (applies before auth)', () => {
  it('429s a flood of WRONG-secret requests instead of leaving them unlimited', async () => {
    // Regression: per-route rateLimit() calls only ever run AFTER checkAuth
    // succeeds, so without a pre-auth global limit, failed-auth requests had
    // no rate limit on them at all.
    const env = baseEnv()
    const statuses: number[] = []
    for (let i = 0; i < 301; i++) {
      const res = await call('/markets', env, { auth: 'wrong-secret' })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 300).every((s) => s === 401)).toBe(true)
    expect(statuses[300]).toBe(429)
  })

  it('429s a flood against /health, which needs no auth at all', async () => {
    const env = baseEnv()
    const statuses: number[] = []
    for (let i = 0; i < 301; i++) {
      const res = await call('/health', env)
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true)
    expect(statuses[300]).toBe(429)
  })

  it('does not rate-limit normal single-digit usage', async () => {
    const env = baseEnv()
    const res = await call('/health', env)
    expect(res.status).toBe(200)
  })
})

describe('rate limiting', () => {
  it('429s after the per-minute limit (/geo = 60/min)', async () => {
    const env = baseEnv()
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) {
      const res = await call('/geo', env, { country: 'RS' })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })

  it('atomicity: concurrent requests never exceed the limit (regression for the old KV race)', async () => {
    // Sequential calls (above) never exercised concurrency at all — each
    // `await call(...)` fully resolved before the next started, so the old
    // KV-based rateLimit()'s get-then-put race never had a chance to fire in
    // that test. Firing every call before awaiting any of them is what
    // actually reproduces the race: with the old KV counter this would let
    // meaningfully more than 10 through; with RateLimiterDO's per-instance
    // serialization (modeled by fakeRateLimiterDO's queue), exactly the
    // limit gets admitted no matter how many arrive at once.
    const env = baseEnv()
    const limit = 60 // /geo = 60/min
    const concurrency = 90
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => call('/geo', env, { country: 'RS' })),
    )
    const allowed = results.filter((r) => r.status === 200).length
    const limited = results.filter((r) => r.status === 429).length
    expect(allowed).toBe(limit)
    expect(limited).toBe(concurrency - limit)
  })
})

describe('/embeddings input limits', () => {
  it('413 when the actual body exceeds the byte cap', async () => {
    // 300KB of real body bytes, comfortably over EMBED_LIMITS.maxBodyBytes (256KB).
    const res = await call('/embeddings', baseEnv(), {
      method: 'POST',
      body: JSON.stringify({ texts: ['x'.repeat(300 * 1024)] }),
    })
    expect(res.status).toBe(413)
  })

  it('413 on an oversized body streamed with NO Content-Length header at all (regression for the header-trust bug)', async () => {
    // Simulates chunked transfer / any client that omits Content-Length —
    // the old check trusted `parseInt(header ?? '0')`, which reads a missing
    // header as 0 and lets an arbitrarily large streamed body straight
    // through to req.json(). The fix must cap on bytes actually read.
    const bigChunk = new TextEncoder().encode('x'.repeat(300 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk)
        controller.close()
      },
    })
    const request = new Request('https://w.example/embeddings', {
      method: 'POST',
      headers: (() => {
        const h = new Headers()
        h.set('Origin', ORIGIN)
        h.set('X-Actually-Auth', 'secret')
        // Deliberately no Content-Length header.
        return h
      })(),
      body: stream,
      duplex: 'half',
    } as RequestInit)
    const res = await worker.fetch(request, baseEnv() as never)
    expect(res.status).toBe(413)
  })

  it('does not reject a normal, small body with no Content-Length quirks', async () => {
    const res = await call('/embeddings', baseEnv(), { method: 'POST', body: JSON.stringify({ texts: ['hello'] }) })
    expect(res.status).not.toBe(413)
  })

  it('400 on a body with no texts array', async () => {
    const res = await call('/embeddings', baseEnv(), { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
  })

  it('400 on too many texts', async () => {
    const texts = Array.from({ length: 65 }, () => 'a')
    const res = await call('/embeddings', baseEnv(), { method: 'POST', body: JSON.stringify({ texts }) })
    expect(res.status).toBe(400)
  })

  it('429 daily_cap_reached when the OpenAI character quota is exhausted', async () => {
    const res = await call('/embeddings', baseEnv({ OPENAI_DAILY_CHAR_LIMIT: '3' }), {
      method: 'POST',
      body: JSON.stringify({ texts: ['abcdef'] }), // 6 chars > 3-char daily cap
    })
    expect(res.status).toBe(429)
    expect((await res.json() as { error?: string }).error).toBe('daily_cap_reached')
  })
})

describe('upstream hosts', () => {
  it('/history proxies to the CLOB prices-history endpoint', async () => {
    const spy = vi.fn(async (..._a: unknown[]) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await call('/history?market=0x1', baseEnv())
    const url = String(spy.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('clob.polymarket.com/prices-history')
    expect(url).not.toContain('gamma-api.polymarket.com/prices-history')
  })

  it('/orderbook proxies to the CLOB book endpoint', async () => {
    const spy = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await call('/orderbook?token_id=0x1', baseEnv())
    expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('clob.polymarket.com/book')
  })

  it('/clob/positions/<address> proxies to the data-api positions endpoint', async () => {
    const spy = vi.fn(async (..._a: unknown[]) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const res = await call('/clob/positions/0x1234567890123456789012345678901234567890', baseEnv())
    expect(res.status).toBe(200)
    expect(String(spy.mock.calls[0]?.[0] ?? '')).toBe(
      'https://data-api.polymarket.com/positions?user=0x1234567890123456789012345678901234567890',
    )
  })

  it('/clob/positions/<address> rejects a malformed address without calling upstream', async () => {
    const spy = vi.fn(async (..._a: unknown[]) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const res = await call('/clob/positions/not-an-address', baseEnv())
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('every upstream proxy call carries an abort signal (bounded timeout, no hung requests)', async () => {
    const spy = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await call('/history?market=0x1', baseEnv())
    await call('/orderbook?token_id=0x1', baseEnv())
    await call('/price?token_id=0x1', baseEnv())
    await call('/markets', baseEnv())
    await call('/clob/positions/0x1234567890123456789012345678901234567890', baseEnv())
    for (const [, init] of spy.mock.calls) {
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal)
    }
  })
})

describe('/telemetry limits', () => {
  function fakeTelemetry() {
    const points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = []
    const dataset = {
      writeDataPoint: vi.fn((dp: { indexes: string[]; blobs: string[]; doubles: number[] }) => {
        points.push(dp)
      }),
    } as unknown as AnalyticsEngineDataset
    return { dataset, points }
  }

  it('drops (ok:true) an oversized body instead of erroring the client', async () => {
    const res = await call('/telemetry', baseEnv(), {
      method: 'POST',
      body: JSON.stringify({ events: [{ event: 'x', meta: { big: 'y'.repeat(100 * 1024) } }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("caps recorded events at Analytics Engine's own 250-per-invocation limit", async () => {
    const { dataset } = fakeTelemetry()
    const events = Array.from({ length: 400 }, (_, i) => ({ event: 'x', installId: 'i', ts: i }))
    const res = await call('/telemetry', baseEnv({ TELEMETRY: dataset }), {
      method: 'POST',
      body: JSON.stringify({ events }),
    })
    expect(res.status).toBe(200)
    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(250)
  })

  it("truncates an oversized meta blob instead of letting it blow Analytics Engine's 16KB per-point blob limit", async () => {
    const { dataset, points } = fakeTelemetry()
    const hugeMeta = { note: 'z'.repeat(50 * 1024) }
    await call('/telemetry', baseEnv({ TELEMETRY: dataset }), {
      method: 'POST',
      body: JSON.stringify({ events: [{ event: 'x', installId: 'i', meta: hugeMeta }] }),
    })
    expect(points[0]?.blobs[1]?.length).toBeLessThanOrEqual(16 * 1024)
  })
})

describe('unhandled exceptions', () => {
  it('logs the real error server-side but never echoes it to the client', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwingKV = {
      get: async () => {
        throw new Error('kv_boom: sensitive_internal_detail')
      },
      put: async () => {},
    } as unknown as KVNamespace
    const res = await call('/market-cache', baseEnv({ MARKET_CACHE: throwingKV }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ error: 'worker_exception' })
    expect(JSON.stringify(body)).not.toContain('sensitive_internal_detail')
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})

describe('market-cache read', () => {
  it('returns 503 when MARKET_CACHE KV is not bound', async () => {
    const res = await call('/market-cache', baseEnv({ MARKET_CACHE: undefined }))
    expect(res.status).toBe(503)
  })

  it('returns 404 when the cache has never been populated', async () => {
    const res = await call('/market-cache', baseEnv())
    expect(res.status).toBe(404)
  })

  it('returns the stored blob verbatim with a 5-minute Cache-Control', async () => {
    const env = baseEnv()
    await (env as { MARKET_CACHE: KVNamespace }).MARKET_CACHE.put(
      'blob',
      JSON.stringify({ model: 'Xenova/all-MiniLM-L12-v2', builtAt: 1, markets: [] }),
    )
    const res = await call('/market-cache', env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(await res.json()).toEqual({ model: 'Xenova/all-MiniLM-L12-v2', builtAt: 1, markets: [] })
  })
})

describe('market-cache write', () => {
  const blob = { model: 'Xenova/all-MiniLM-L12-v2', builtAt: 1700000000000, markets: [{ id: 'm1', question: 'Will X?', embeddingB64: 'AAAA' }] }

  it('rejects without MARKET_CACHE_WRITE_SECRET configured', async () => {
    const res = await call('/market-cache', baseEnv(), { method: 'PUT', body: JSON.stringify(blob) })
    expect(res.status).toBe(503)
  })

  it('rejects a wrong write secret', async () => {
    const res = await call('/market-cache', baseEnv({ MARKET_CACHE_WRITE_SECRET: 'right' }), {
      method: 'PUT',
      headers: { 'X-Actually-Cache-Write': 'wrong' },
      body: JSON.stringify(blob),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed blob', async () => {
    const res = await call('/market-cache', baseEnv({ MARKET_CACHE_WRITE_SECRET: 'right' }), {
      method: 'PUT',
      headers: { 'X-Actually-Cache-Write': 'right' },
      body: JSON.stringify({ model: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT then GET round-trips the blob', async () => {
    const env = baseEnv({ MARKET_CACHE_WRITE_SECRET: 'right' })
    const put = await call('/market-cache', env, {
      method: 'PUT',
      headers: { 'X-Actually-Cache-Write': 'right' },
      body: JSON.stringify(blob),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, count: 1 })

    const get = await call('/market-cache', env)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual(blob)
  })
})

describe('builder signing (remote signer for Polymarket relayer)', () => {
  const RELAYER_CREDS = {
    RELAYER_API_KEY: 'rk-456',
    RELAYER_API_KEY_ADDRESS: '0xC6B48f603C439B4a6b55462AfCae10594D31242A',
  }
  const CREDS = {
    BUILDER_API_KEY: 'bk-123',
    // Base64, because the SDK base64-DECODES the secret before using it as
    // the HMAC key.
    BUILDER_API_SECRET: Buffer.from('super-secret-bytes').toString('base64'),
    BUILDER_API_PASSPHRASE: 'pass-phrase',
  }

  it('produces exactly the signature Polymarket\'s own SDK produces', async () => {
    // The whole point of this endpoint: the relayer answers 401 for any
    // signature that differs by a byte. Pin ours against the published
    // implementation rather than against our own understanding of it.
    // Cast through unknown: the SDK's own .d.ts types `timestamp` as a
    // number while its JS just concatenates it, and the relayer signs over
    // the string form either way.
    const { buildHmacSignature } = (await import(
      '@polymarket/builder-signing-sdk/dist/signing/hmac.js'
    )) as unknown as { buildHmacSignature: (s: string, t: string, m: string, p: string, b?: string) => string }
    const { buildBuilderSignature } = await import('./index')

    const cases: Array<[string, string, string, string | undefined]> = [
      ['1700000000', 'POST', '/submit', '{"a":1}'],
      ['1700000001', 'GET', '/transactions', undefined],
      // A body with characters that push base64 into '+' and '/' territory,
      // which must come back URL-safe but still '='-padded.
      ['1755400000', 'POST', '/submit', JSON.stringify({ blob: '???>>>~~~\u00ff' })],
    ]
    for (const [ts, method, path, body] of cases) {
      expect(await buildBuilderSignature(CREDS.BUILDER_API_SECRET, ts, method, path, body)).toBe(
        buildHmacSignature(CREDS.BUILDER_API_SECRET, ts, method, path, body),
      )
    }

    // Polymarket issues URL-SAFE base64 secrets ('-' and '_' in the
    // alphabet). The SDK decodes them with Node's lenient Buffer.from;
    // plain atob() throws — which is how every live /builder-sign call
    // 500'd on a perfectly valid secret (2026-08-18). Pin equality on
    // exactly that alphabet, and on a secret with sloppy-paste whitespace.
    const urlSafeSecret = 'q-_Zx-9_AbC123-_'
    expect(await buildBuilderSignature(urlSafeSecret, '1755500000', 'POST', '/submit', '{}')).toBe(
      buildHmacSignature(urlSafeSecret, '1755500000', 'POST', '/submit', '{}'),
    )
    const spacedSecret = ' q-_Zx-9_AbC123-_\n'
    expect(await buildBuilderSignature(spacedSecret, '1755500000', 'POST', '/submit', '{}')).toBe(
      buildHmacSignature(spacedSecret, '1755500000', 'POST', '/submit', '{}'),
    )
  })

  it('returns the four POLY_BUILDER_* headers, and never the secret itself', async () => {
    const env = baseEnv(CREDS)
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/submit', body: '{"x":1}' }),
    })
    expect(res.status).toBe(200)
    const h = (await res.json()) as Record<string, string>
    expect(Object.keys(h).sort()).toEqual([
      'POLY_BUILDER_API_KEY',
      'POLY_BUILDER_PASSPHRASE',
      'POLY_BUILDER_SIGNATURE',
      'POLY_BUILDER_TIMESTAMP',
    ])
    expect(JSON.stringify(h)).not.toContain(CREDS.BUILDER_API_SECRET)
  })

  it('stamps its own timestamp instead of trusting the caller', async () => {
    const env = baseEnv(CREDS)
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/submit', timestamp: 1 }),
    })
    const h = (await res.json()) as Record<string, string>
    // A replayed or skewed timestamp is rejected by the relayer, so ours must win.
    expect(Number(h.POLY_BUILDER_TIMESTAMP)).toBeGreaterThan(1_700_000_000)
  })

  it('refuses to sign for paths outside the redeem flow', async () => {
    // The credential can authenticate any relayer endpoint; an open-ended
    // signer would hand that reach to anyone holding the public client secret.
    const env = baseEnv(CREDS)
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/deploy' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as unknown).toEqual({ error: 'path_not_signable' })
  })

  it('still requires the shared secret and a known extension origin', async () => {
    const env = baseEnv(CREDS)
    const body = JSON.stringify({ method: 'POST', path: '/submit' })
    expect((await call('/builder-sign', env, { method: 'POST', body, auth: 'wrong' })).status).toBe(401)
    // A foreign Origin is rejected as 401 (bad_origin) — same treatment as a
    // bad secret; see checkAuth's note on why Origin is checked only when
    // present.
    expect((await call('/builder-sign', env, { method: 'POST', body, origin: 'https://evil.example' })).status).toBe(401)
  })

  it('reports 503 — not a broken signature — when no credentials are set', async () => {
    const res = await call('/builder-sign', baseEnv(), {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/submit' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()) as unknown).toEqual({ error: 'builder_creds_not_configured' })
  })

  it('tells the client whether in-app redeem can work at all, and via which scheme', async () => {
    expect(await (await call('/builder-status', baseEnv())).json()).toEqual({ configured: false })
    expect(await (await call('/builder-status', baseEnv(CREDS))).json()).toEqual({ configured: true, mode: 'builder' })
    expect(await (await call('/builder-status', baseEnv(RELAYER_CREDS))).json()).toEqual({ configured: true, mode: 'relayer' })
  })

  it('serves the static relayer-key headers when that is the scheme configured', async () => {
    // Polymarket's settings UI currently hands out relayer API keys (key +
    // owning address, no HMAC) — the second auth scheme POST /submit accepts.
    const env = baseEnv(RELAYER_CREDS)
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/submit', body: '{"x":1}' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown).toEqual({
      RELAYER_API_KEY: 'rk-456',
      RELAYER_API_KEY_ADDRESS: '0xC6B48f603C439B4a6b55462AfCae10594D31242A',
    })
  })

  it('prefers builder HMAC creds when both schemes are configured', async () => {
    // The HMAC scheme never reveals the secret to the client; the static key
    // scheme does. When the stronger option exists, use it.
    const env = baseEnv({ ...CREDS, ...RELAYER_CREDS })
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/submit' }),
    })
    const h = (await res.json()) as Record<string, string>
    expect(h.POLY_BUILDER_API_KEY).toBe('bk-123')
    expect(h.RELAYER_API_KEY).toBeUndefined()
  })

  it('still refuses unlisted paths in relayer mode', async () => {
    const env = baseEnv(RELAYER_CREDS)
    const res = await call('/builder-sign', env, {
      method: 'POST',
      body: JSON.stringify({ method: 'POST', path: '/deploy' }),
    })
    expect(res.status).toBe(403)
  })

  it('caps daily signatures at the Unverified tier limit', async () => {
    const env = baseEnv(CREDS)
    const body = JSON.stringify({ method: 'POST', path: '/submit' })
    // 100/day is the whole relayer allowance; quietly burning it must not be
    // something a stranger can do. Each call comes from a different IP, both
    // to model a distributed caller and to get past the per-IP minute limit
    // (10/min) that would otherwise stop the loop long before the daily cap.
    const from = (i: number) => ({
      method: 'POST',
      body,
      headers: { 'CF-Connecting-IP': `10.0.${Math.floor(i / 250)}.${i % 250}` },
    })
    for (let i = 0; i < 100; i++) {
      expect((await call('/builder-sign', env, from(i))).status).toBe(200)
    }
    const res = await call('/builder-sign', env, from(101))
    expect(res.status).toBe(429)
    expect((await res.json()) as unknown).toEqual({ error: 'builder_daily_limit_reached' })
  })
})

describe('Authorization: Bearer (the remote-signer envelope)', () => {
  it('accepts the shared secret as a Bearer token, and still rejects a wrong one', async () => {
    // Polymarket's builder-signing-sdk decides this header name, not us.
    const env = baseEnv()
    const ok = await call('/health', env, { headers: { Authorization: 'Bearer secret' }, auth: null })
    expect(ok.status).toBe(200)
    const good = await call('/geo', env, { headers: { Authorization: 'Bearer secret' }, auth: null })
    expect(good.status).toBe(200)
    const bad = await call('/geo', env, { headers: { Authorization: 'Bearer nope' }, auth: null })
    expect(bad.status).toBe(401)
  })
})

describe('/search — the long-tail lookup', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Gamma's public-search answers with EVENTS wrapping their markets. */
  function stubSearch(payload: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
  }

  it('flattens events to markets and carries the event slug', async () => {
    // polymarket.com routes on the EVENT slug; the market's own slug 404s.
    stubSearch({
      events: [{ slug: 'trump-dc-guard', markets: [{ id: '1', question: 'Guard in DC?', closed: false }] }],
    })
    const res = await call('/search?q=national+guard', baseEnv())
    expect(res.status).toBe(200)
    const out = (await res.json()) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Guard in DC?')
    expect(out[0].events).toEqual([{ slug: 'trump-dc-guard' }])
  })

  it('drops resolved markets — search indexes them, the user cannot trade them', async () => {
    stubSearch({
      events: [{ slug: 'e', markets: [
        { id: '1', question: 'Already settled', closed: true },
        { id: '2', question: 'Still open', closed: false },
      ] }],
    })
    const out = (await (await call('/search?q=x', baseEnv())).json()) as Array<Record<string, unknown>>
    expect(out.map((m) => m.question)).toEqual(['Still open'])
  })

  it('rejects an empty query instead of asking Gamma for everything', async () => {
    const res = await call('/search?q=%20%20', baseEnv())
    expect(res.status).toBe(400)
  })

  it('caps how much it will return, whatever the caller asks for', async () => {
    stubSearch({
      events: [{ slug: 'e', markets: Array.from({ length: 200 }, (_, i) => ({ id: String(i), question: `q${i}`, closed: false })) }],
    })
    const out = (await (await call('/search?q=x&limit=999', baseEnv())).json()) as unknown[]
    expect(out.length).toBeLessThanOrEqual(50)
  })

  it('reports an upstream failure as 502 rather than as an empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const res = await call('/search?q=x', baseEnv())
    expect(res.status).toBe(502)
  })
})

describe('market-cache limits track MAX_MARKETS_CACHE', () => {
  it('accepts a blob larger than the old 800-market cap', async () => {
    // The cap moved to 2000 markets (~7.5 MB). The old 1000/5 MB ceilings
    // would have 400ed or 413ed the cron silently, leaving a stale blob
    // served forever with nothing in the logs to explain it.
    expect(MARKET_CACHE_LIMITS.maxMarkets).toBeGreaterThanOrEqual(2000)
    expect(MARKET_CACHE_LIMITS.maxBodyBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024)
  })
})

describe('CORS preflight must allow the header the signing SDK actually sends', () => {
  it('advertises Authorization, without which in-app redeem cannot work at all', async () => {
    // The bug this pins: checkAuth() accepted `Authorization: Bearer`, but the
    // preflight never advertised it. @polymarket/builder-signing-sdk's remote
    // mode sends the token that way and no other, Authorization is not
    // CORS-safelisted, so Chrome blocked the offscreen document's fetch to
    // /builder-sign before it left the browser. The SDK then submitted to
    // relayer-v2 with no builder headers and got a correct 401 — which the
    // popup reported as Polymarket refusing us over a missing builder key,
    // while that key sat on the Worker signing 200s for every non-browser
    // caller. Every layer was individually "fine".
    const res = await call('/builder-sign', baseEnv(), { method: 'OPTIONS' })
    const allowed = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('x-actually-auth')
  })

  it('still accepts the Bearer form end to end, so the header and the policy agree', async () => {
    const env = baseEnv({ BUILDER_API_KEY: 'k', BUILDER_API_SECRET: 'c2VjcmV0', BUILDER_API_PASSPHRASE: 'p' })
    const res = await call('/builder-sign', env, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ method: 'POST', path: '/submit', body: '{}' }),
      auth: null,
    })
    expect(res.status).toBe(200)
  })
})

describe('/privacy — the one page that must work without a credential', () => {
  it('serves the policy as HTML with no auth header at all', async () => {
    // The Chrome Web Store requires a live URL, and reviewers arrive with no
    // credential. Gating this behind checkAuth would have made the listing
    // unsubmittable in a way nothing else would have caught.
    const res = await call('/privacy', baseEnv(), { auth: null, origin: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body.startsWith('<!doctype html>')).toBe(true)
    expect(body).toMatch(/never leaves your device/)
  })

  it('works with no shared secret configured, unlike every other route', async () => {
    const res = await call('/privacy', baseEnv({ WORKER_SHARED_SECRET: undefined }), { auth: null })
    expect(res.status).toBe(200)
  })

  it('answers HEAD without a body — link checkers use it', async () => {
    const res = await call('/privacy', baseEnv(), { method: 'HEAD', auth: null })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('is cacheable, since it changes only on deploy', async () => {
    const res = await call('/privacy', baseEnv(), { auth: null })
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=\d+/)
  })
})
