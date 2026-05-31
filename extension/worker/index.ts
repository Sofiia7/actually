/// <reference types="@cloudflare/workers-types" />
/**
 * Actually API — Cloudflare Worker
 *
 * Proxies extension requests to external APIs (Polymarket Gamma, CLOB, OpenAI)
 * with auth + rate limiting. Phase 1: read-only proxy. Phase 1.5: signed-order
 * relay via builderCode.
 */

interface Env {
  WORKER_SHARED_SECRET?: string
  ALLOWED_EXTENSION_ID?: string
  WORKER_DEV_MODE?: string // "true" allows running without a shared secret
  OPENAI_API_KEY?: string
  /** Hard daily cap of /embeddings requests across all clients. Default 5000. */
  OPENAI_DAILY_LIMIT?: string
  POLYMARKET_BUILDER_CODE?: string
  RATE_LIMITS?: KVNamespace
}

/**
 * Per-day spend cap for OpenAI requests, enforced via KV counter shared across
 * all users. Protects the operator from a single bad actor draining the key.
 * Returns true if the request is allowed, false if the daily quota is exhausted.
 */
async function openAiDailyCap(env: Env): Promise<boolean> {
  if (!env.RATE_LIMITS) return true
  const limit = parseInt(env.OPENAI_DAILY_LIMIT ?? '5000', 10)
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const key = `openai_day:${day}`
  const cur = parseInt((await env.RATE_LIMITS.get(key)) ?? '0', 10)
  if (cur >= limit) return false
  // 25 hour TTL covers the rollover and lets the value GC itself
  await env.RATE_LIMITS.put(key, String(cur + 1), { expirationTtl: 90_000 })
  return true
}

// Polymarket-restricted jurisdictions. Mirrors the client list in
// src/background/geo.ts; the Worker is the source of truth at request time.
const BLOCKED_COUNTRIES = new Set<string>([
  'US', 'GB', 'FR', 'BE', 'AU', 'SG', 'TH', 'TW', 'PL',
])

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Actually-Auth',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json',
}

/**
 * Parse the ALLOWED_EXTENSION_ID env var. Supports a comma-separated list so
 * an operator can keep the CWS production id alongside dev/unpacked ids
 * without rotating between them. Returns the set of `chrome-extension://<id>`
 * origins the Worker will accept.
 */
function allowedOrigins(allowedExtId: string | undefined): Set<string> {
  if (!allowedExtId) return new Set()
  return new Set(
    allowedExtId
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => `chrome-extension://${id}`),
  )
}

function corsHeaders(origin: string | null, allowedExtId: string | undefined): HeadersInit {
  const allowed = allowedOrigins(allowedExtId)
  // Fail-closed: if no extension ID is configured, refuse to echo a usable
  // origin. The browser will block the response and the operator gets a clear
  // signal that ALLOWED_EXTENSION_ID needs to be set before going live.
  if (allowed.size === 0) {
    // Browsers sometimes treat `Access-Control-Allow-Origin: null` as a match
    // for opaque origins (file://, sandboxed iframes). Echo a clearly-invalid
    // URL instead — no browser ever matches this, and the operator sees the
    // misconfig in DevTools.
    return { ...CORS_BASE, 'Access-Control-Allow-Origin': 'https://__actually_misconfigured__.invalid' }
  }
  // Echo back the request origin if it's in the allow-list; otherwise return
  // the first allowed origin (browser will block, but operator sees the
  // configured value in DevTools).
  const echo = origin && allowed.has(origin) ? origin : [...allowed][0]
  return { ...CORS_BASE, 'Access-Control-Allow-Origin': echo }
}

function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

async function rateLimit(
  env: Env,
  bucket: string,
  ip: string,
  perMinute: number,
): Promise<boolean> {
  if (!env.RATE_LIMITS) return true
  const window = Math.floor(Date.now() / 60_000)
  const key = `rl:${bucket}:${ip}:${window}`
  const cur = parseInt((await env.RATE_LIMITS.get(key)) ?? '0', 10)
  if (cur >= perMinute) return false
  await env.RATE_LIMITS.put(key, String(cur + 1), { expirationTtl: 120 })
  return true
}

/**
 * Auth result with explicit status codes so the caller can return the right
 * HTTP status (503 for misconfiguration vs 401 for bad credentials).
 */
function checkAuth(req: Request, env: Env): { ok: boolean; status?: number; reason?: string } {
  // Fail-closed: a Worker with no shared secret is a misconfiguration, not a
  // dev convenience. Operators must opt into bypass with WORKER_DEV_MODE=true.
  if (!env.WORKER_SHARED_SECRET) {
    if (env.WORKER_DEV_MODE === 'true') return { ok: true }
    return { ok: false, status: 503, reason: 'worker_misconfigured_no_secret' }
  }
  if (!env.ALLOWED_EXTENSION_ID && env.WORKER_DEV_MODE !== 'true') {
    return { ok: false, status: 503, reason: 'worker_misconfigured_no_extension_id' }
  }

  const auth = req.headers.get('X-Actually-Auth')
  if (auth !== env.WORKER_SHARED_SECRET) {
    return { ok: false, status: 401, reason: 'bad_secret' }
  }

  const origin = req.headers.get('Origin')
  if (env.ALLOWED_EXTENSION_ID && origin) {
    const allowed = allowedOrigins(env.ALLOWED_EXTENSION_ID)
    if (!allowed.has(origin)) return { ok: false, status: 401, reason: 'bad_origin' }
  }
  return { ok: true }
}

function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ??
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const origin = req.headers.get('Origin')
    const headers = corsHeaders(origin, env.ALLOWED_EXTENSION_ID)

    if (req.method === 'OPTIONS') return new Response(null, { headers })

    // Health probe — no auth, no body
    if (url.pathname === '/health') {
      return json({ ok: true, ts: Date.now() }, 200, headers)
    }

    const auth = checkAuth(req, env)
    if (!auth.ok) {
      const status = auth.status ?? 401
      const errorKey = status === 503 ? 'misconfigured' : 'unauthorized'
      return json({ error: errorKey, reason: auth.reason }, status, headers)
    }

    const ip = clientIp(req)

    try {
      // --- Polymarket Gamma: market list ----------------------------
      if (url.pathname === '/markets' && req.method === 'GET') {
        if (!(await rateLimit(env, 'markets', ip, 30))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(
          `https://gamma-api.polymarket.com/markets?${params}`,
          { headers: { Accept: 'application/json' } },
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Polymarket CLOB: live price ------------------------------
      if (url.pathname === '/price' && req.method === 'GET') {
        if (!(await rateLimit(env, 'price', ip, 120))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(`https://clob.polymarket.com/price?${params}`)
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- OpenAI embeddings (centralized — uses Worker env key) ----
      if (url.pathname === '/embeddings' && req.method === 'POST') {
        if (!(await rateLimit(env, 'embed', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const apiKey = env.OPENAI_API_KEY
        if (!apiKey) return json({ error: 'no_openai_key' }, 503, headers)
        if (!(await openAiDailyCap(env))) {
          return json({ error: 'daily_cap_reached' }, 429, headers)
        }
        const body = (await req.json()) as { texts: string[]; model?: string }
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: body.model ?? 'text-embedding-3-small',
            input: body.texts,
          }),
        })
        if (!res.ok) {
          return json({ error: 'openai_failed', status: res.status }, 502, headers)
        }
        const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
        return json({ embeddings: data.data.map((d) => d.embedding) }, 200, headers)
      }

      // --- Polymarket CLOB: orderbook -------------------------------
      if (url.pathname === '/orderbook' && req.method === 'GET') {
        if (!(await rateLimit(env, 'orderbook', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(
          `https://clob.polymarket.com/book?${params}`,
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Polymarket Gamma: price history --------------------------
      if (url.pathname === '/history' && req.method === 'GET') {
        if (!(await rateLimit(env, 'history', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(
          `https://gamma-api.polymarket.com/prices-history?${params}`,
          { headers: { Accept: 'application/json' } },
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Geo check via CF headers ---------------------------------
      if (url.pathname === '/geo' && req.method === 'GET') {
        if (!(await rateLimit(env, 'geo', ip, 10))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const country = (req.headers.get('CF-IPCountry') ?? '').toUpperCase()
        const region = (req.headers.get('CF-Region-Code') ?? '').toUpperCase()
        const extra = (env as unknown as { EXTRA_BLOCKED_COUNTRIES?: string })
          .EXTRA_BLOCKED_COUNTRIES
        const extraSet = new Set(
          (extra ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
        )
        const blocked =
          BLOCKED_COUNTRIES.has(country) ||
          extraSet.has(country) ||
          (country === 'CA' && region === 'ON')
        return json({ country, region, blocked }, 200, headers)
      }

      // --- Polymarket Safe (funder) lookup by EOA -------------------
      // GET /clob/proxy/<eoa> — returns the Polymarket Safe address.
      //
      // Polymarket's public data-api exposes the proxy wallet under a few
      // shapes that have shifted historically. We try the canonical
      // /proxyWallet first, fall back to /wallet, and tolerate both
      // `proxyWallet` and `proxy` field names in the response.
      if (url.pathname.startsWith('/clob/proxy/') && req.method === 'GET') {
        if (!(await rateLimit(env, 'proxy', ip, 30))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const eoa = url.pathname.slice('/clob/proxy/'.length).toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(eoa)) {
          return json({ error: 'bad_eoa' }, 400, headers)
        }
        const candidates = [
          `https://data-api.polymarket.com/proxyWallet?address=${eoa}`,
          `https://data-api.polymarket.com/wallet?user=${eoa}`,
        ]
        let addr: string | undefined
        let lastStatus = 0
        for (const u of candidates) {
          try {
            const res = await fetch(u)
            lastStatus = res.status
            if (!res.ok) continue
            const data = (await res.json()) as Record<string, unknown>
            const v =
              (data.proxyWallet as string | undefined) ??
              (data.proxy as string | undefined) ??
              (data.safe as string | undefined) ??
              (data.wallet as string | undefined) ??
              (data.address as string | undefined)
            if (v && typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
              addr = v
              break
            }
          } catch {
            // try next
          }
        }
        if (!addr) {
          return json(
            { error: 'lookup_failed', status: lastStatus },
            lastStatus === 404 ? 404 : 502,
            headers,
          )
        }
        return json({ proxyWallet: addr.toLowerCase() }, 200, headers)
      }

      // --- Telemetry ingest (anonymous) -----------------------------
      if (url.pathname === '/telemetry' && req.method === 'POST') {
        if (!(await rateLimit(env, 'telem', ip, 30))) {
          return json({ ok: true }, 200, headers) // silently drop
        }
        const body = (await req.json()) as { events: unknown[] }
        // For now: log only. Wire to Analytics Engine / D1 later.
        console.log(`[telemetry] ${body.events?.length ?? 0} events from ${ip}`)
        return json({ ok: true }, 200, headers)
      }

      return json({ error: 'not_found' }, 404, headers)
    } catch (err) {
      return json({ error: 'worker_exception', detail: String(err) }, 500, headers)
    }
  },
}
