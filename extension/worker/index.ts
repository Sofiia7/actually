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
  /**
   * Atomic per-IP rate limiting + the OpenAI daily character cap — see
   * RateLimiterDO below. Replaced a KV read-then-write counter (see git
   * history) that had a race window: concurrent requests could read the same
   * stale count and both increment from it, letting a determined caller
   * exceed the nominal limit by several times. A Durable Object instance
   * processes one request at a time (Cloudflare's core DO guarantee), so the
   * read-then-write here is genuinely atomic with no extra locking needed.
   */
  RATE_LIMITER_DO?: DurableObjectNamespace
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
  /**
   * Builder API credentials from polymarket.com -> Settings -> Builders ->
   * "+ Create New". They authenticate POST /submit on Polymarket's relayer
   * (gasless Safe operations: redeeming resolved positions), via HMAC headers
   * the SDK calls POLY_BUILDER_*.
   *
   * They live HERE and only here. Unlike WORKER_SHARED_SECRET (public by
   * design — it ships inside every extension build), this credential is the
   * builder account's own: anything holding it can spend the builder's daily
   * relayer quota. The extension never sees it; it asks this Worker to sign
   * each request instead (POST /builder-sign), which is the "remote signer"
   * mode Polymarket's own @polymarket/builder-signing-sdk supports.
   */
  BUILDER_API_KEY?: string
  BUILDER_API_SECRET?: string
  BUILDER_API_PASSPHRASE?: string
  /**
   * Alternative relayer auth: a RELAYER API KEY, the second scheme
   * POST /submit accepts. Unlike the builder triple it is just two static
   * headers (key + owning address) — no HMAC, no passphrase — and it is
   * ACCOUNT-scoped: it authorizes gasless operations for the address that
   * created it, which is what Polymarket's settings UI currently hands out
   * (Settings → API Keys → Relayer API Keys).
   *
   * Trade-off vs builder mode: in remote-signer flow the client receives the
   * headers to attach, so in relayer mode the KEY ITSELF transits to the
   * client (an HMAC signature doesn't reveal the builder secret; a static
   * key IS the credential). Holding it doesn't let anyone move funds — every
   * /submit still needs the user's own Safe signature — but it can read the
   * owner's relayer transactions and burn rate limit. Acceptable while the
   * only client is the operator's own unpublished build; switch to builder
   * creds for public launch. Builder creds take precedence when both exist.
   */
  RELAYER_API_KEY?: string
  RELAYER_API_KEY_ADDRESS?: string
}

/**
 * One Durable Object instance per rate-limit counter (e.g. "rl:markets:1.2.3.4"
 * or "openai-daily-cap"), addressed via idFromName so the same logical counter
 * always routes to the same instance. The instance holds a single {windowStart,
 * count} record and resets itself the moment `now` crosses into a new window —
 * no explicit TTL/expiry needed, and no per-window instance proliferation
 * (unlike embedding the window into the DO name, which would mint a fresh,
 * permanently-stored instance every single minute).
 *
 * Atomicity comes from the platform, not from code in this class: Cloudflare
 * guarantees a given Durable Object instance processes one request to
 * completion before starting the next (the "input gate"), so the
 * get-then-put below can never interleave with a concurrent call to the same
 * instance the way the old KV-based version could.
 */
export class RateLimiterDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { windowMs, limit, amount } = (await request.json()) as {
      windowMs: number
      limit: number
      amount: number
    }
    const now = Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const existing = await this.state.storage.get<{ windowStart: number; count: number }>('bucket')
    const bucket = existing && existing.windowStart === windowStart ? existing : { windowStart, count: 0 }
    if (bucket.count + amount > limit) {
      return new Response(JSON.stringify({ allowed: false, count: bucket.count }))
    }
    bucket.count += amount
    await this.state.storage.put('bucket', bucket)
    return new Response(JSON.stringify({ allowed: true, count: bucket.count }))
  }
}

/**
 * Per-day spend cap for OpenAI requests, enforced via the atomic
 * RateLimiterDO counter, shared across all users. Protects the operator from
 * a single bad actor draining the key. Returns true if the request is
 * allowed, false if the daily quota is exhausted.
 */
async function openAiCharCap(env: Env, chars: number): Promise<boolean> {
  const limit = parseInt(env.OPENAI_DAILY_CHAR_LIMIT ?? '5000000', 10)
  return checkRateLimit(env, 'openai-daily-cap', 86_400_000, limit, chars)
}

/**
 * Reads a request body up to `maxBytes`, enforcing the cap on the actual
 * bytes received rather than trusting the `Content-Length` header — a
 * chunked-transfer request (or one that simply omits the header) has no
 * Content-Length at all, which `parseInt(... ?? '0')` reads as 0 and lets
 * straight through the old header-only check, after which `req.json()` would
 * buffer the entire body regardless of size. Returns `null` if the body
 * exceeds the cap (caller should respond 413) or can't be read.
 */
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string | null> {
  const reader = req.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const buf = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(buf)
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

/**
 * Input limits for the /telemetry route. `maxEvents` is capped at
 * Analytics Engine's own hard limit — "a maximum of 250 data points per
 * Worker invocation" (developers.cloudflare.com/analytics/analytics-engine/limits/)
 * — not an arbitrary product choice: the old cap of 1000 let a client believe
 * a whole batch was recorded (every event returns `{ ok: true }` per the
 * "never error a client on telemetry" policy below) while everything past
 * #250 silently failed writeDataPoint() and was swallowed by the per-event
 * catch. `maxBodyBytes` guards the same way readBodyWithLimit already does
 * for /embeddings and PUT /market-cache — parsing an unbounded body is real
 * Worker compute/memory regardless of how many events end up used.
 * `maxBlobBytes` mirrors Analytics Engine's own "combined blobs must not
 * exceed 16 KB per data point" limit so a single oversized `meta` can't get
 * silently dropped by writeDataPoint() the same way.
 */
export const TELEMETRY_LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxEvents: 250,
  maxBlobBytes: 16 * 1024,
} as const

/** Per-upstream-fetch timeout — see the `signal:` argument on every outbound fetch() below. */
const UPSTREAM_TIMEOUT_MS = 10_000

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
  // A 2000-market blob is ~7.5 MB: 384 float32s per market, base64'd, is
  // 2 KB of the ~3.8 KB each row costs. The old 5 MB ceiling was sized for
  // the old 800-market cap and would 413 the cron silently — leaving a stale
  // blob served indefinitely with nothing in the logs to say why.
  maxBodyBytes: 12 * 1024 * 1024,
  // MAX_MARKETS_CACHE (2000) plus headroom, so a builder that overfetches
  // slightly is not rejected outright.
  maxMarkets: 2200,
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

// Polymarket-restricted jurisdictions (commercial-availability restrictions)
// plus comprehensively OFAC-sanctioned jurisdictions (a separate, stricter
// obligation than Polymarket's own market-access list — the builder code
// attached to every order means we are a monetizing counterparty, not just
// a UI). Mirrors the client list in src/background/geo.ts; the Worker is the
// source of truth at request time. EXTRA_BLOCKED_COUNTRIES (see wrangler.toml)
// is for fast additions without a redeploy.
const BLOCKED_COUNTRIES = new Set<string>([
  'US', 'GB', 'FR', 'BE', 'AU', 'SG', 'TH', 'TW', 'PL',
  'IR', 'KP', 'CU', 'SY', // OFAC-sanctioned: Iran, North Korea, Cuba, Syria
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

/**
 * HMAC-SHA256 builder signature, byte-for-byte what
 * @polymarket/builder-signing-sdk's buildHmacSignature produces: the message
 * is `timestamp + method + path + body`, the secret is base64-DECODED before
 * use, and the resulting base64 is made URL-safe (+ -> -, / -> _) while
 * KEEPING its '=' padding. Any deviation yields a signature the relayer
 * rejects with 401, so this is pinned by a test against the SDK itself.
 */
/** Which relayer-auth scheme this deployment can sign for, if any. */
function relayerAuthMode(env: Env): 'builder' | 'relayer' | null {
  if (env.BUILDER_API_KEY && env.BUILDER_API_SECRET && env.BUILDER_API_PASSPHRASE) return 'builder'
  if (env.RELAYER_API_KEY && env.RELAYER_API_KEY_ADDRESS) return 'relayer'
  return null
}

/**
 * Base64 → bytes with Node's `Buffer.from(s, 'base64')` semantics, which is
 * what the signing SDK decodes the secret with: tolerate the URL-SAFE
 * alphabet, whitespace, and missing padding. Plain atob() throws on all
 * three — and Polymarket issues url-safe base64 secrets (hit live
 * 2026-08-18: every /builder-sign call 500'd on a perfectly valid secret).
 */
function b64ToBytes(s: string): Uint8Array {
  const norm = s.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export async function buildBuilderSignature(
  secretB64: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  const message = `${timestamp}${method}${requestPath}${body ?? ''}`
  const keyBytes = b64ToBytes(secretB64)
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return b64.replaceAll('+', '-').replaceAll('/', '_')
}

/**
 * Paths this Worker is willing to sign for. The builder credential can
 * authenticate ANY relayer endpoint, so an open-ended signer would let anyone
 * holding the (deliberately public) client secret spend the builder's daily
 * relayer quota on arbitrary calls. Redeeming needs exactly these two.
 */
const SIGNABLE_RELAYER_PATHS = new Set(['/submit', '/transactions'])

/** Daily ceiling on signatures issued, mirroring the Builder Program's
 * Unverified tier (100 relayer txns/day). Stops quota exhaustion from being
 * something a stranger can do quietly; raise alongside a tier upgrade. */
const BUILDER_SIGN_DAILY_LIMIT = 100

function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

let warnedNoDo = false

/**
 * Shared entry point for both per-IP rate limiting and the OpenAI daily
 * cap: routes a check-and-increment of `amount` (default 1) against the
 * named counter's Durable Object instance. `name` fully identifies the
 * counter (e.g. `rl:markets:1.2.3.4` or `openai-daily-cap`) — the window
 * itself is NOT embedded in the name; RateLimiterDO tracks and resets its
 * own window internally so the same counter instance is reused forever
 * instead of minting a new persisted instance every window.
 */
async function checkRateLimit(
  env: Env,
  name: string,
  windowMs: number,
  limit: number,
  amount = 1,
): Promise<boolean> {
  if (!env.RATE_LIMITER_DO) {
    if (!warnedNoDo) {
      warnedNoDo = true
      console.warn(
        '[actually] RATE_LIMITER_DO is not bound — per-IP rate limiting and the ' +
          'OpenAI daily quota are DISABLED (fail-open). This is only reachable in ' +
          'WORKER_DEV_MODE; production refuses authenticated routes without it (see checkAuth).',
      )
    }
    return true
  }
  const id = env.RATE_LIMITER_DO.idFromName(name)
  const stub = env.RATE_LIMITER_DO.get(id)
  const res = await stub.fetch('https://rate-limiter/increment', {
    method: 'POST',
    body: JSON.stringify({ windowMs, limit, amount }),
  })
  const data = (await res.json()) as { allowed: boolean }
  return data.allowed
}

async function rateLimit(
  env: Env,
  bucket: string,
  ip: string,
  perMinute: number,
): Promise<boolean> {
  return checkRateLimit(env, `rl:${bucket}:${ip}`, 60_000, perMinute)
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
  // RateLimiterDO is the real abuse backstop — the shared secret is publicly
  // extractable from the shipped build (see SECURITY.md), so without it every
  // per-IP limit and the OpenAI daily cap silently fail-open. Refuse to serve
  // authenticated routes in prod until RATE_LIMITER_DO is bound; dev mode
  // (WORKER_DEV_MODE=true) still allows running without it for local work.
  if (!env.RATE_LIMITER_DO && env.WORKER_DEV_MODE !== 'true') {
    return { ok: false, status: 503, reason: 'worker_misconfigured_no_rate_limiter' }
  }

  // `Authorization: Bearer <secret>` is accepted alongside our own header
  // because Polymarket's builder-signing-sdk sends the remote-signer token
  // that way and the header name isn't ours to choose (see /builder-sign).
  // Same secret, same checks — only the envelope differs.
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
  const auth = req.headers.get('X-Actually-Auth') ?? bearer
  if (auth !== env.WORKER_SHARED_SECRET) {
    return { ok: false, status: 401, reason: 'bad_secret' }
  }

  const origin = req.headers.get('Origin')
  if (env.ALLOWED_EXTENSION_ID && origin) {
    // Origin is validated only when PRESENT. Browsers set it and pages can't
    // forge it, so a mismatched Origin (a foreign website's fetch) is safely
    // rejected. Its ABSENCE, however, is normal for the worker's legitimate
    // non-browser clients — the market-cache cron builder and the published
    // MCP server — and rejecting it (tried 2026-07-08, deployed 2026-07-14)
    // broke both in production the same day while stopping no real attacker:
    // any curl caller can set the header. The shared secret gates access;
    // the RateLimiterDO per-IP limits + OpenAI daily cap are the abuse
    // backstop (see SECURITY.md threat model).
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

    const ip = clientIp(req)

    // Global per-IP cap, applied before auth and before any per-route limit
    // below. Every per-route `rateLimit(...)` call only ever runs AFTER
    // checkAuth succeeds, so without this a flood of wrong-secret requests —
    // or repeated hits to /health, which needs no auth at all — had NO rate
    // limit whatsoever: unbounded compute against the operator's Workers
    // quota/bill, and more attempts per second to brute-force
    // WORKER_SHARED_SECRET (negligible on its own given its 256-bit entropy,
    // but there's no reason to leave this window open when it's cheap to
    // close). Generous enough that no legitimate single-IP usage pattern
    // (one extension instance across all its routes) gets near it.
    if (!(await rateLimit(env, 'global', ip, 300))) {
      return json({ error: 'rate_limited' }, 429, headers)
    }

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

    try {
      // --- Polymarket Gamma: market list ----------------------------
      if (url.pathname === '/markets' && req.method === 'GET') {
        // 90/min, not 30: the cache builder now pages three orderings and
        // discards per-game sports rows as it goes, so filling 2000 markets
        // takes ~40 requests in one run. At 30 it half-filled the cache with
        // 429s. Still a read-only Gamma proxy, so the ceiling is about our
        // upstream budget rather than protecting anything sensitive.
        if (!(await rateLimit(env, 'markets', ip, 90))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(
          `https://gamma-api.polymarket.com/markets?${params}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Polymarket market search (long-tail fallback) ------------
      //
      // The precomputed cache is a fixed-size shelf; Polymarket carries far
      // more open markets than fit on it. When an article matches nothing
      // cached, the extension can ask here instead of reporting a dead end.
      //
      // Gamma's public-search answers with EVENTS wrapping their markets, so
      // this flattens to plain market records (carrying the event slug, which
      // is what polymarket.com actually routes on) and drops resolved ones —
      // a closed market is not something the user could act on.
      if (url.pathname === '/search' && req.method === 'GET') {
        if (!(await rateLimit(env, 'search', ip, 20))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
        if (!q) return json({ error: 'missing_query' }, 400, headers)
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25))
        const upstream = new URLSearchParams({ q, limit_per_type: String(limit) })
        const res = await fetch(
          `https://gamma-api.polymarket.com/public-search?${upstream}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
        )
        if (!res.ok) return json({ error: 'upstream_error', status: res.status }, 502, headers)
        let parsed: unknown
        try {
          parsed = await res.json()
        } catch {
          return json({ error: 'bad_upstream_json' }, 502, headers)
        }
        const events = (parsed as { events?: unknown[] } | null)?.events
        const out: unknown[] = []
        for (const ev of Array.isArray(events) ? events : []) {
          const e = ev as { slug?: string; markets?: unknown[] } | null
          if (!e) continue
          for (const mk of Array.isArray(e.markets) ? e.markets : []) {
            const m = mk as Record<string, unknown> | null
            if (!m || m.closed === true) continue
            out.push({ ...m, events: [{ slug: e.slug }] })
            if (out.length >= limit) break
          }
          if (out.length >= limit) break
        }
        return json(out, 200, headers)
      }

      // --- Polymarket CLOB: live price ------------------------------
      if (url.pathname === '/price' && req.method === 'GET') {
        if (!(await rateLimit(env, 'price', ip, 120))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const params = url.searchParams.toString()
        const res = await fetch(`https://clob.polymarket.com/price?${params}`, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- OpenAI embeddings (centralized — uses Worker env key) ----
      if (url.pathname === '/embeddings' && req.method === 'POST') {
        if (!(await rateLimit(env, 'embed', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const apiKey = env.OPENAI_API_KEY
        if (!apiKey) return json({ error: 'no_openai_key' }, 503, headers)

        // Reject oversized bodies before parsing (cheap DoS guard) — enforced
        // on actual bytes read, not the (spoofable/omittable) Content-Length
        // header.
        const embedBody = await readBodyWithLimit(req, EMBED_LIMITS.maxBodyBytes)
        if (embedBody === null) {
          return json({ error: 'body_too_large' }, 413, headers)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(embedBody)
        } catch {
          return json({ error: 'bad_json' }, 400, headers)
        }
        const v = validateEmbeddingsInput(parsed)
        if (!v.ok) return json({ error: v.error }, v.status, headers)

        // Per-day character quota (aggregate across all clients).
        if (!(await openAiCharCap(env, v.totalChars))) {
          return json({ error: 'daily_cap_reached' }, 429, headers)
        }

        // Pin the model server-side rather than honor a caller-supplied one:
        // this is the only model any caller has ever actually requested, and
        // letting an arbitrary caller (anyone holding the public-by-design
        // shared secret) pick a pricier OpenAI model bills the operator's
        // own key for whatever they chose.
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: v.texts,
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
          { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
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
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
        )
        return new Response(await res.text(), { status: res.status, headers })
      }

      // --- Geo check via CF headers / request.cf ---------------------
      if (url.pathname === '/geo' && req.method === 'GET') {
        // 60/min, up from 10/min — this is a cheap header read (no upstream
        // fetch), and every Trade-tab mount/connect/submit triggers one
        // (OS_GET_GEO force-resets the client's 5-min cache), so several
        // active users behind one shared IP (office/CGNAT) — or a single
        // user rapidly reopening the popup — could trip a 10/min cap on
        // themselves and hit the prod fail-closed "couldn't verify region"
        // block for no abuse reason at all.
        if (!(await rateLimit(env, 'geo', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const rawCountry = (req.headers.get('CF-IPCountry') ?? '').toUpperCase()
        // Cloudflare sends 'T1' for Tor exit traffic and 'XX' when it
        // genuinely can't geolocate the request — neither is a confirmed
        // country. The client (geo.ts) treats any non-empty `country` as a
        // CONFIRMED verdict, so passing these through as-is would silently
        // skip the fail-closed posture (GEO_FAIL_OPEN=false in prod) for
        // exactly the traffic most likely to be evading it. Report an empty
        // country instead so the client's existing "no country → unknown,
        // fail closed in prod" handling engages.
        const country = rawCountry === 'T1' || rawCountry === 'XX' ? '' : rawCountry
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

      // --- Builder signing (remote signer for Polymarket's relayer) --
      //
      // The extension can't hold the builder credential (it would be public
      // in every install), and Polymarket's relayer requires builder auth on
      // POST /submit. So the client asks us to sign each request: exactly the
      // "remote signer" contract @polymarket/builder-signing-sdk implements —
      // POST {method, path, body?, timestamp?}, receive the POLY_BUILDER_*
      // headers back. The credential never leaves this Worker.
      if (url.pathname === '/builder-status' && req.method === 'GET') {
        if (!(await rateLimit(env, 'builder_status', ip, 60))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        // Lets the UI offer in-app redeem only when it can actually work,
        // instead of asking for a wallet signature that ends in a 401.
        const mode = relayerAuthMode(env)
        return json({ configured: mode !== null, ...(mode ? { mode } : {}) }, 200, headers)
      }

      if (url.pathname === '/builder-sign' && req.method === 'POST') {
        if (!(await rateLimit(env, 'builder_sign', ip, 10))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const authMode = relayerAuthMode(env)
        if (!authMode) {
          return json({ error: 'builder_creds_not_configured' }, 503, headers)
        }
        let payload: { method?: unknown; path?: unknown; body?: unknown; timestamp?: unknown }
        try {
          payload = (await req.json()) as typeof payload
        } catch {
          return json({ error: 'bad_body' }, 400, headers)
        }
        const method = typeof payload.method === 'string' ? payload.method.toUpperCase() : ''
        const path = typeof payload.path === 'string' ? payload.path : ''
        if (!method || !path) {
          return json({ error: 'bad_request' }, 400, headers)
        }
        if (!SIGNABLE_RELAYER_PATHS.has(path.split('?')[0])) {
          return json({ error: 'path_not_signable' }, 403, headers)
        }
        const reqBody = typeof payload.body === 'string' ? payload.body : undefined
        if (reqBody && reqBody.length > 200_000) {
          return json({ error: 'body_too_large' }, 413, headers)
        }
        // Daily quota guard — see BUILDER_SIGN_DAILY_LIMIT.
        if (!(await checkRateLimit(env, 'builder-sign-daily', 86_400_000, BUILDER_SIGN_DAILY_LIMIT))) {
          return json({ error: 'builder_daily_limit_reached' }, 429, headers)
        }
        if (authMode === 'relayer') {
          // Static-header scheme: no HMAC, nothing to compute. See the Env
          // doc comment for the security trade-off of returning the key.
          return json(
            {
              RELAYER_API_KEY: env.RELAYER_API_KEY!.trim(),
              RELAYER_API_KEY_ADDRESS: env.RELAYER_API_KEY_ADDRESS!.trim(),
            },
            200,
            headers,
          )
        }
        // The SDK lets the caller pass a timestamp; the relayer validates it
        // against its own clock, so trusting a client value invites a skewed
        // (or replayed) signature. Ours is the only one that can be right.
        const timestamp = String(Math.floor(Date.now() / 1000))
        // trim(): a pasted-in secret can pick up stray whitespace, and a
        // header value with a trailing space authenticates as garbage.
        let signature: string
        try {
          signature = await buildBuilderSignature(
            env.BUILDER_API_SECRET!.trim(),
            timestamp,
            method,
            path,
            reqBody,
          )
        } catch (err) {
          // Never echo the secret; the shape of the failure is enough.
          return json(
            { error: `builder_sign_failed:${err instanceof Error ? err.message : 'bad_secret_encoding'}` },
            500,
            headers,
          )
        }
        return json(
          {
            POLY_BUILDER_API_KEY: env.BUILDER_API_KEY!.trim(),
            POLY_BUILDER_TIMESTAMP: timestamp,
            POLY_BUILDER_PASSPHRASE: env.BUILDER_API_PASSPHRASE!.trim(),
            POLY_BUILDER_SIGNATURE: signature,
          },
          200,
          headers,
        )
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
        const cacheBody = await readBodyWithLimit(req, MARKET_CACHE_LIMITS.maxBodyBytes)
        if (cacheBody === null) {
          return json({ error: 'body_too_large' }, 413, headers)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(cacheBody)
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
            const res = await fetch(u, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
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

      // --- Positions lookup by Safe address --------------------------
      // GET /clob/positions/<address> — proxies data-api.polymarket.com so
      // the client's real IP + Safe address are never sent to Polymarket
      // directly (see privacy-policy.md's "All API calls go through
      // Cloudflare" claim — this route is what makes that claim true for
      // the positions panel too, not just market/price/geo lookups).
      if (url.pathname.startsWith('/clob/positions/') && req.method === 'GET') {
        if (!(await rateLimit(env, 'positions', ip, 30))) {
          return json({ error: 'rate_limited' }, 429, headers)
        }
        const addr = url.pathname.slice('/clob/positions/'.length).toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(addr)) {
          return json({ error: 'bad_address' }, 400, headers)
        }
        const res = await fetch(`https://data-api.polymarket.com/positions?user=${addr}`, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        if (!res.ok) {
          return json({ error: 'positions_fetch_failed', status: res.status }, 502, headers)
        }
        const body = await res.text()
        return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } })
      }

      // --- Telemetry ingest (anonymous) -----------------------------
      if (url.pathname === '/telemetry' && req.method === 'POST') {
        if (!(await rateLimit(env, 'telem', ip, 30))) {
          return json({ ok: true }, 200, headers) // silently drop
        }
        // Same "reject oversized bodies before parsing" guard as /embeddings
        // and PUT /market-cache — see readBodyWithLimit's doc comment.
        const telemRaw = await readBodyWithLimit(req, TELEMETRY_LIMITS.maxBodyBytes)
        if (telemRaw === null) {
          return json({ ok: true }, 200, headers) // never error a client on telemetry — just drop it
        }
        let telemBody: { events?: unknown[] }
        try {
          telemBody = JSON.parse(telemRaw) as { events?: unknown[] }
        } catch {
          return json({ ok: true }, 200, headers) // never error a client on telemetry
        }
        // Capped at Analytics Engine's own per-invocation writeDataPoint()
        // limit (250) — see TELEMETRY_LIMITS' doc comment. Anything beyond
        // this would previously fail server-side and be swallowed by the
        // per-event catch below, silently under-counting the client's batch.
        const events = Array.isArray(telemBody.events) ? telemBody.events.slice(0, TELEMETRY_LIMITS.maxEvents) : []
        if (env.TELEMETRY) {
          for (const e of events) {
            const ev = e as { event?: string; installId?: string; ts?: number; meta?: unknown }
            try {
              const installIdBlob = String(ev.installId ?? '').slice(0, 128)
              const metaBlob = JSON.stringify(ev.meta ?? {}).slice(0, TELEMETRY_LIMITS.maxBlobBytes)
              env.TELEMETRY.writeDataPoint({
                indexes: [String(ev.event ?? 'unknown').slice(0, 96)],
                blobs: [installIdBlob, metaBlob],
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
      // Log the real detail server-side (visible via `wrangler tail` / the
      // Workers dashboard) but never echo it to the client — anyone holding
      // the public-by-design shared secret could otherwise read internal
      // error strings (upstream fetch failures, DO errors, stack traces).
      console.error('[worker_exception]', err)
      return json({ error: 'worker_exception' }, 500, headers)
    }
  },
}
