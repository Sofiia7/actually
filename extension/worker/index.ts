/// <reference types="@cloudflare/workers-types" />
/**
 * Actually API — Cloudflare Worker
 *
 * Proxies extension requests to external APIs (Polymarket Gamma, CLOB, OpenAI)
 * with auth + rate limiting. Phase 1: read-only proxy. Phase 1.5: signed-order
 * relay via builderCode.
 */
import type { MarketCacheBlob } from '@actually/core'

interface Env {
  WORKER_SHARED_SECRET?: string
  ALLOWED_EXTENSION_ID?: string
  WORKER_DEV_MODE?: string // "true" allows running without a shared secret
  OPENAI_API_KEY?: string
  /** Hard daily cap of embedded CHARACTERS across all clients. Default 5,000,000. */
  OPENAI_DAILY_CHAR_LIMIT?: string
  POLYMARKET_BUILDER_CODE?: string
  RATE_LIMITS?: KVNamespace
  /** Optional Analytics Engine dataset for telemetry persistence. */
  TELEMETRY?: AnalyticsEngineDataset
  /** Precomputed market-cache blob storage — see /market-cache routes. */
  MARKET_CACHE?: KVNamespace
  /**
   * Guards PUT /market-cache. Unlike WORKER_SHARED_SECRET (public by design,
   * baked into every client), this secret is NEVER baked into anything —
   * only the precompute cron job holds it.
   */
  MARKET_CACHE_WRITE_SECRET?: string
}

/**
 * Per-day spend cap for OpenAI requests, enforced via KV counter shared across
 * all users. Protects the operator from a single bad actor draining the key.
 * Returns true if the request is allowed, false if the daily quota is exhausted.
 */
async function openAiCharCap(env: Env, chars: number): Promise<boolean> {
  if (!env.RATE_LIMITS) return true
  const limit = parseInt(env.OPENAI_DAILY_CHAR_LIMIT ?? '5000000', 10)
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const key = `openai_chars_day:${day}`
  const cur = parseInt((await env.RATE_LIMITS.get(key)) ?? '0', 10)
  if (cur + chars > limit) return false
  // 25 hour TTL covers the rollover and lets the value GC itself
  await env.RATE_LIMITS.put(key, String(cur + chars), { expirationTtl: 90_000 })
  return true
}

/**
 * Input limits for the /embeddings route. The Worker secret is publicly
 * extractable (see SECURITY.md), so a caller could otherwise post arbitrarily
 * large batches and drain the operator's OpenAI bill. These bound a single
 * request; the per-day character quota (openAiCharCap) bounds the aggregate.
 */
export const EMBED_LIMITS = {
  maxTexts: 64,
  maxCharsPerText: 2000,
  maxTotalChars: 20_000,
  maxBodyBytes: 256 * 1024,
} as const

export type EmbeddingsValidation =
  | { ok: true; texts: string[]; model?: string; totalChars: number }
  | { ok: false; status: number; error: string }

/** Pure validation for an /embeddings request body. No I/O — unit-tested. */
export function validateEmbeddingsInput(body: unknown): EmbeddingsValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'bad_body' }
  }
  const b = body as { texts?: unknown; model?: unknown }
  if (!Array.isArray(b.texts)) return { ok: false, status: 400, error: 'texts_not_array' }
  if (b.texts.length === 0) return { ok: false, status: 400, error: 'texts_empty' }
  if (b.texts.length > EMBED_LIMITS.maxTexts) {
    return { ok: false, status: 400, error: 'too_many_texts' }
  }
  let totalChars = 0
  for (const t of b.texts) {
    if (typeof t !== 'string') return { ok: false, status: 400, error: 'text_not_string' }
    if (t.length > EMBED_LIMITS.maxCharsPerText) {
      return { ok: false, status: 400, error: 'text_too_long' }
    }
    totalChars += t.length
  }
  if (totalChars > EMBED_LIMITS.maxTotalChars) {
    return { ok: false, status: 400, error: 'total_too_large' }
  }
  const model = typeof b.model === 'string' ? b.model : undefined
  return { ok: true, texts: b.texts as string[], model, totalChars }
}

/**
 * Input limits for PUT /market-cache. The blob holds ~800 markets at ~2KB of
 * base64 embedding each (~1.6MB total at MAX_MARKETS_CACHE) — 5MB leaves
 * comfortable headroom without allowing an unbounded upload.
 */
export const MARKET_CACHE_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024,
  maxMarkets: 1000,
} as const

export type MarketCacheValidation =
  | { ok: true; blob: MarketCacheBlob }
  | { ok: false; status: number; error: string }

/** Pure validation for a PUT /market-cache request body. No I/O — unit-tested. */
export function validateMarketCacheInput(body: unknown): MarketCacheValidation {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'bad_body' }
  }
  const b = body as { model?: unknown; builtAt?: unknown; markets?: unknown }
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { ok: false, status: 400, error: 'bad_model' }
  }
  if (typeof b.builtAt !== 'number' || !Number.isFinite(b.builtAt)) {
    return { ok: false, status: 400, error: 'bad_builtAt' }
  }
  if (!Array.isArray(b.markets)) {
    return { ok: false, status: 400, error: 'markets_not_array' }
  }
  if (b.markets.length === 0) {
    return { ok: false, status: 400, error: 'markets_empty' }
  }
  if (b.markets.length > MARKET_CACHE_LIMITS.maxMarkets) {
    return { ok: false, status: 400, error: 'too_many_markets' }
  }
  for (const m of b.markets) {
    if (typeof m !== 'object' || m === null) return { ok: false, status: 400, error: 'bad_market_entry' }
    const mm = m as Record<string, unknown>
    if (typeof mm.id !== 'string' || typeof mm.question !== 'string' || typeof mm.embeddingB64 !== 'string') {
      return { ok: false, status: 400, error: 'bad_market_shape' }
    }
  }
  return { ok: true, blob: body as MarketCacheBlob }
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

let warnedNoKv = false

async function rateLimit(
  env: Env,
  bucket: string,
  ip: string,
  perMinute: number,
): Promise<boolean> {
  if (!env.RATE_LIMITS) {
    if (!warnedNoKv) {
      warnedNoKv = true
      console.warn(
        '[actually] RATE_LIMITS KV is not bound — per-IP rate limiting and the ' +
          'OpenAI daily quota are DISABLED (fail-open). This is only reachable in ' +
          'WORKER_DEV_MODE; production refuses authenticated routes without KV (see checkAuth).',
      )
    }
    return true
  }
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
  // The rate-limit KV is the real abuse backstop — the shared secret is
  // publicly extractable from the shipped build (see SECURITY.md), so without
  // KV every per-IP limit and the OpenAI daily cap silently fail-open. Refuse
  // to serve authenticated routes in prod until RATE_LIMITS is bound; dev mode
  // (WORKER_DEV_MODE=true) still allows running without it for local work.
  if (!env.RATE_LIMITS && env.WORKER_DEV_MODE !== 'true') {
    return { ok: false, status: 503, reason: 'worker_misconfigured_no_kv' }
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

        // Reject oversized bodies before parsing (cheap DoS guard).
        const contentLength = parseInt(req.headers.get('Content-Length') ?? '0', 10)
        if (Number.isFinite(contentLength) && contentLength > EMBED_LIMITS.maxBodyBytes) {
          return json({ error: 'body_too_large' }, 413, headers)
        }

        let parsed: unknown
        try {
          parsed = await req.json()
        } catch {
          return json({ error: 'bad_json' }, 400, headers)
        }
        const v = validateEmbeddingsInput(parsed)
        if (!v.ok) return json({ error: v.error }, v.status, headers)

        // Per-day character quota (aggregate across all clients).
        if (!(await openAiCharCap(env, v.totalChars))) {
          return json({ error: 'daily_cap_reached' }, 429, headers)
        }

        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: v.model ?? 'text-embedding-3-small',
            input: v.texts,
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
        // Price history lives on the CLOB host, not Gamma. (Gamma's
        // /prices-history 404s.) See https://docs.polymarket.com/api-reference/markets/get-prices-history
        const res = await fetch(
          `https://clob.polymarket.com/prices-history?${params}`,
          { headers: { Accept: 'application/json' } },
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Geo check via CF headers / request.cf ---------------------
      if (url.pathname === '/geo' && req.method === 'GET') {
        if (!(await rateLimit(env, 'geo', ip, 10))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const country = (req.headers.get('CF-IPCountry') ?? '').toUpperCase()
        // Cloudflare does NOT add a CF-Region-Code *header* to Worker
        // requests (only CF-IPCountry/CF-Connecting-IP/CF-Ray/CF-Visitor are
        // guaranteed headers). Region-level geolocation is only available via
        // the `cf` object the Workers runtime attaches to the incoming
        // Request (IncomingRequestCfProperties.regionCode). Reading a header
        // that's never sent would silently never match CA+ON.
        const region = (req.cf?.regionCode ?? '').toString().toUpperCase()
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

      // --- Market cache: read (agents / MCP server) -----------------
      if (url.pathname === '/market-cache' && req.method === 'GET') {
        if (!(await rateLimit(env, 'market_cache_read', ip, 20))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        if (!env.MARKET_CACHE) {
          return json({ error: 'market_cache_not_configured' }, 503, headers)
        }
        const raw = await env.MARKET_CACHE.get('blob')
        if (!raw) {
          return json({ error: 'not_populated' }, 404, headers)
        }
        return new Response(raw, {
          status: 200,
          headers: { ...headers, 'Cache-Control': 'public, max-age=300' },
        })
      }

      // --- Market cache: write (precompute cron job only) -----------
      if (url.pathname === '/market-cache' && req.method === 'PUT') {
        if (!(await rateLimit(env, 'market_cache_write', ip, 6))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        if (!env.MARKET_CACHE) {
          return json({ error: 'market_cache_not_configured' }, 503, headers)
        }
        if (!env.MARKET_CACHE_WRITE_SECRET) {
          return json({ error: 'write_secret_not_configured' }, 503, headers)
        }
        const writeAuth = req.headers.get('X-Actually-Cache-Write')
        if (writeAuth !== env.MARKET_CACHE_WRITE_SECRET) {
          return json({ error: 'unauthorized' }, 401, headers)
        }
        const contentLength = parseInt(req.headers.get('Content-Length') ?? '0', 10)
        if (Number.isFinite(contentLength) && contentLength > MARKET_CACHE_LIMITS.maxBodyBytes) {
          return json({ error: 'body_too_large' }, 413, headers)
        }
        let parsed: unknown
        try {
          parsed = await req.json()
        } catch {
          return json({ error: 'bad_json' }, 400, headers)
        }
        const v = validateMarketCacheInput(parsed)
        if (!v.ok) return json({ error: v.error }, v.status, headers)
        await env.MARKET_CACHE.put('blob', JSON.stringify(v.blob))
        return json({ ok: true, count: v.blob.markets.length }, 200, headers)
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
        let telemBody: { events?: unknown[] }
        try {
          telemBody = (await req.json()) as { events?: unknown[] }
        } catch {
          return json({ ok: true }, 200, headers) // never error a client on telemetry
        }
        const events = Array.isArray(telemBody.events) ? telemBody.events.slice(0, 1000) : []
        if (env.TELEMETRY) {
          for (const e of events) {
            const ev = e as { event?: string; installId?: string; ts?: number; meta?: unknown }
            try {
              env.TELEMETRY.writeDataPoint({
                indexes: [String(ev.event ?? 'unknown')],
                blobs: [String(ev.installId ?? ''), JSON.stringify(ev.meta ?? {})],
                doubles: [typeof ev.ts === 'number' ? ev.ts : Date.now()],
              })
            } catch {
              // skip a malformed event; never fail the batch
            }
          }
        } else {
          console.log(`[telemetry] ${events.length} events from ${ip} (no TELEMETRY binding)`)
        }
        return json({ ok: true }, 200, headers)
      }

      return json({ error: 'not_found' }, 404, headers)
    } catch (err) {
      return json({ error: 'worker_exception', detail: String(err) }, 500, headers)
    }
  },
}
