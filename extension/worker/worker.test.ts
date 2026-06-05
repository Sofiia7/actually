import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'

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

function baseEnv(over: Record<string, unknown> = {}) {
  return {
    WORKER_SHARED_SECRET: 'secret',
    ALLOWED_EXTENSION_ID: EXT,
    OPENAI_API_KEY: 'sk-test',
    RATE_LIMITS: fakeKV(),
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
  if (o.region) h.set('CF-Region-Code', o.region)
  return new Request(`https://w.example${path}`, { method: o.method ?? 'GET', headers: h, body: o.body })
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

  it('rejects an origin not in the allow-list', async () => {
    const res = await call('/geo', baseEnv(), { origin: 'chrome-extension://someoneelse' })
    expect(res.status).toBe(401)
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
})

describe('rate limiting', () => {
  it('429s after the per-minute limit (/geo = 10/min)', async () => {
    const env = baseEnv()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await call('/geo', env, { country: 'RS' })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe('/embeddings input limits', () => {
  it('413 when Content-Length exceeds the body cap', async () => {
    const res = await call('/embeddings', baseEnv(), {
      method: 'POST',
      headers: { 'Content-Length': String(300 * 1024) },
      body: '{}',
    })
    expect(res.status).toBe(413)
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
})
