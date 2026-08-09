import type { PolyMarket } from './types'
import type { RawOrderbook } from './orderbook'

function authHeaders(workerSecret: string): HeadersInit {
  return { 'X-Actually-Auth': workerSecret, 'Content-Type': 'application/json' }
}

// Gamma API caps each page at 100 results regardless of the `limit` param,
// so we paginate via `offset`. `order=volumeNum` is the only sort that
// returns by actual numeric volume — `order=volume` sorts the field as a
// string, producing nonsense.
const GAMMA_PAGE = 100

type RawGammaMarket = Partial<PolyMarket> & {
  clobTokenIds?: string | string[]
  volumeNum?: number
  endDate?: string
  end_date_iso?: string
  description?: string
  resolutionSource?: string
  resolution_source?: string
  negRisk?: boolean
  neg_risk?: boolean
  // Gamma names this differently across versions
  orderPriceMinTickSize?: number | string
  tickSize?: number | string
  minimumTickSize?: number | string
  orderMinSize?: number | string
  minimum_order_size?: number | string
}

/** Normalize one raw Gamma market record into our `PolyMarket` shape. Returns
 * null when required fields are missing (caller skips the record). */
function parseGammaMarket(m: RawGammaMarket): PolyMarket | null {
  if (!m.id || !m.question || !m.outcomePrices || !m.outcomes) return null
  return {
    id: String(m.id),
    slug: m.slug ?? '',
    question: m.question,
    outcomePrices: m.outcomePrices,
    outcomes: m.outcomes,
    volume: Number(m.volumeNum ?? m.volume ?? 0),
    liquidity: Number(m.liquidity ?? 0),
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    clobTokenIds: parseClobTokenIds(m.clobTokenIds),
    endDate: m.endDate ?? m.end_date_iso,
    description: m.description,
    resolutionSource: m.resolutionSource ?? m.resolution_source,
    negRisk: m.negRisk ?? m.neg_risk ?? false,
    tickSize: normalizeTick(m.orderPriceMinTickSize ?? m.tickSize ?? m.minimumTickSize),
    minOrderSize: normalizeMinOrderSize(m.orderMinSize ?? m.minimum_order_size),
  }
}

/** Gamma sends `orderMinSize` as a number, but has shipped it as a string
 * before (same drift as the tick fields). Anything unusable becomes
 * undefined so callers fall back to DEFAULT_MIN_ORDER_SHARES. */
function normalizeMinOrderSize(raw: number | string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export async function fetchActiveMarkets(
  workerUrl: string,
  workerSecret: string,
  total = 300,
): Promise<PolyMarket[]> {
  const out: PolyMarket[] = []
  const seenIds = new Set<string>()
  const pages = Math.ceil(total / GAMMA_PAGE)
  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(GAMMA_PAGE),
      offset: String(i * GAMMA_PAGE),
      order: 'volumeNum',
      ascending: 'false',
    })
    // Gamma occasionally returns a transient 5xx; the Worker proxies it through.
    // Retry a few times with backoff so one upstream blip doesn't abort the
    // whole refresh. Non-5xx errors (4xx) are not retried.
    let res: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${workerUrl}/markets?${params}`, {
        headers: authHeaders(workerSecret),
      })
      if (res.ok || res.status < 500) break
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
    if (!res || !res.ok) throw new Error(`fetch_markets_failed:${res?.status ?? 'network'}`)
    const raw = (await res.json()) as RawGammaMarket[]
    if (raw.length === 0) break
    for (const m of raw) {
      const parsed = parseGammaMarket(m)
      if (!parsed || seenIds.has(parsed.id)) continue
      seenIds.add(parsed.id)
      out.push(parsed)
      if (out.length >= total) return out
    }
  }
  return out
}

/**
 * Fetch a single market by id directly from Gamma (via the worker's /markets
 * proxy), bypassing the precomputed top-N-by-volume cache. Used as a fallback
 * when a caller has a valid marketId that didn't make the cache's volume cut
 * (the cache only holds MAX_MARKETS_CACHE markets). Returns null if Gamma has
 * no such market (unknown id, or it fell outside active/closed filters).
 */
export async function fetchMarketById(
  marketId: string,
  workerUrl: string,
  workerSecret: string,
): Promise<PolyMarket | null> {
  const params = new URLSearchParams({ id: marketId })
  const res = await fetch(`${workerUrl}/markets?${params}`, { headers: authHeaders(workerSecret) })
  if (!res.ok) return null
  const raw = (await res.json()) as RawGammaMarket[]
  if (!Array.isArray(raw) || raw.length === 0) return null
  // No `?? raw[0]` fallback: this sits directly on the order-placement path
  // (mcp-server's resolveMarket → place_order/sell_order). Silently trading
  // whatever Gamma happened to return first on an id mismatch would sign an
  // order against a market the caller never asked for.
  const match = raw.find((m) => String(m.id) === marketId)
  if (!match) return null
  return parseGammaMarket(match)
}

/**
 * Normalize Gamma's tick-size value to a decimal string CLOB accepts
 * ("0.01", "0.001", ...). Returns undefined when the input doesn't look like
 * a valid tick — the caller then falls back to negRisk-based defaults.
 *
 * Exported for unit testing; production callsite is `fetchActiveMarkets`.
 */
export function normalizeTick(v: number | string | undefined): string | undefined {
  if (v == null) return undefined
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return undefined
  // CLOB tick sizes are powers of 10 (0.01 / 0.001 / 0.0001). Keep up to
  // 6 decimals and strip trailing zeros so the string round-trips cleanly.
  return n.toFixed(6).replace(/\.?0+$/, '')
}

function parseClobTokenIds(v: string | string[] | undefined): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export async function fetchLivePrice(
  tokenId: string,
  workerUrl: string,
  workerSecret: string,
): Promise<number | null> {
  try {
    const params = new URLSearchParams({ token_id: tokenId, side: 'buy' })
    const res = await fetch(`${workerUrl}/price?${params}`, {
      headers: authHeaders(workerSecret),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { price?: string }
    return data.price ? parseFloat(data.price) : null
  } catch {
    return null
  }
}

/**
 * Fetch the raw CLOB orderbook via the worker's unauthenticated-to-CLOB proxy
 * (public order-book data — no signer or wallet needed). Returns an empty
 * book rather than throwing on failure so callers can degrade gracefully
 * (e.g. get_market still returns market info without a live orderbook).
 */
export async function fetchOrderbookJson(
  tokenId: string,
  workerUrl: string,
  workerSecret: string,
): Promise<RawOrderbook> {
  try {
    const params = new URLSearchParams({ token_id: tokenId })
    const res = await fetch(`${workerUrl}/orderbook?${params}`, {
      headers: authHeaders(workerSecret),
    })
    if (!res.ok) return { asks: [], bids: [] }
    return (await res.json()) as RawOrderbook
  } catch {
    return { asks: [], bids: [] }
  }
}
