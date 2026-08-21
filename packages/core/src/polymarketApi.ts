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
  /** Gamma nests the parent event(s); its slug is what polymarket.com/event/
   * actually routes on. The market's own slug often differs and 404s. */
  events?: Array<{ slug?: string }>
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
  /** Set by Gamma on per-fixture sports rows — see isPerGameSportsMarket. */
  gameId?: string | number
  sportsMarketType?: string
}

/** Normalize one raw Gamma market record into our `PolyMarket` shape. Returns
 * null when required fields are missing (caller skips the record). */
function parseGammaMarket(m: RawGammaMarket): PolyMarket | null {
  if (!m.id || !m.question || !m.outcomePrices || !m.outcomes) return null
  return {
    id: String(m.id),
    slug: m.slug ?? '',
    eventSlug: m.events?.find((e) => e?.slug)?.slug,
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

/**
 * A per-game sports market: one row per fixture, resolving within hours.
 *
 * Gamma flags these outright (`gameId`, `sportsMarketType`), which matters
 * because they overwhelm any ordering that isn't lifetime volume. Measured on
 * 2026-08-21 across the top 800 of each ordering: 0% of `volumeNum`, 13% of
 * `volume24hr`, and 83% of `createdAt`. A recency slice without this filter
 * is not a recency slice, it is a list of Dota fixtures.
 *
 * They are dropped from every slice, not just recency. No news article is
 * usefully answered by "Dota 2: Team Liquid vs Team Falcons - Game 1 Winner",
 * and the cache budget they would eat is the whole point of this exercise.
 */
function isPerGameSportsMarket(m: RawGammaMarket): boolean {
  return Boolean(m.gameId || m.sportsMarketType)
}

/**
 * How the cached market set is chosen.
 *
 * This used to be "top N by lifetime volume", full stop, and that is the
 * wrong shelf for a tool that reads the news. `volumeNum` is volume over a
 * market's whole life, so it ranks by ACCUMULATED interest: a market opened
 * this morning under today's headline has near-zero lifetime volume and loses
 * to a year-old election market every time. Measured on the live cache, the
 * cheapest market that made the cut had $508,649 of lifetime volume — so a
 * real, open, actively-traded market like "Who will Trump publicly insult by
 * August 31?" ($47,851) was invisible to the extension by a factor of ten,
 * and the user reasonably read that as "the tool is broken".
 *
 * Three orderings, blended:
 *   volume24hr  what is being traded RIGHT NOW, which is what news is about
 *   volumeNum   the big standing markets, still the backbone of good answers
 *   startDate   freshly opened markets, which by definition have no history
 *
 * Shares are deliberate: recency gets the smallest slice because it is the
 * noisiest, and lifetime volume keeps a large one because those markets are
 * the ones most articles genuinely match.
 */
export const CACHE_SLICES: ReadonlyArray<{ order: string; share: number }> = [
  { order: 'volume24hr', share: 0.4 },
  { order: 'volumeNum', share: 0.4 },
  { order: 'startDate', share: 0.2 },
]

/**
 * Gamma refuses offsets past ~2100 with a 422, so a slice that filters
 * heavily can run out of pages before it fills its quota. That is expected,
 * and the top-up pass below covers the shortfall.
 */
const GAMMA_MAX_OFFSET = 2000

/**
 * Pause between pages, so a full build stays under the Worker's /markets
 * budget (90 requests per minute per IP). Filling 2000 markets takes roughly
 * forty requests once per-game sports rows are discarded; at ~0.9s each that
 * is a ~35s fetch phase on the cron and about ten seconds on the extension's
 * much smaller on-device fallback. Without the spacing the run simply
 * collects 429s and half-fills the cache.
 */
const PAGE_DELAY_MS = 700

export async function fetchActiveMarkets(
  workerUrl: string,
  workerSecret: string,
  total = 300,
): Promise<PolyMarket[]> {
  const out: PolyMarket[] = []
  const seenIds = new Set<string>()

  /** Page one ordering until `out` reaches `upTo` or Gamma runs out. */
  async function fillFrom(order: string, upTo: number): Promise<void> {
    for (let offset = 0; offset <= GAMMA_MAX_OFFSET; offset += GAMMA_PAGE) {
      if (out.length >= upTo) return
      const params = new URLSearchParams({
        active: 'true',
        closed: 'false',
        limit: String(GAMMA_PAGE),
        offset: String(offset),
        order,
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
      if (raw.length === 0) return
      for (const m of raw) {
        if (isPerGameSportsMarket(m)) continue
        const parsed = parseGammaMarket(m)
        if (!parsed || seenIds.has(parsed.id)) continue
        seenIds.add(parsed.id)
        out.push(parsed)
        if (out.length >= upTo) return
      }
      // Filtering can push a slice past thirty requests a minute, which is
      // what the Worker's /markets proxy allows per IP. Spacing the pages
      // keeps an unattended cron run under it instead of half-filling the
      // cache with 429s.
      if (PAGE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
    }
  }

  for (const slice of CACHE_SLICES) {
    await fillFrom(slice.order, Math.min(total, out.length + Math.ceil(total * slice.share)))
  }
  // A slice can come up short — heavy filtering, Gamma's offset ceiling, an
  // ordering with fewer rows than expected. Backfill from lifetime volume so
  // a thin slice costs coverage of ITS kind, not the size of the whole cache.
  if (out.length < total) await fillFrom('volumeNum', total)
  return out.slice(0, total)
}

/**
 * Free-text market lookup through the Worker's /search proxy.
 *
 * The cache is a fixed-size shelf, so however it is chosen, the long tail is
 * off it — Polymarket carries thousands of open markets and the cache holds
 * two thousand. This is the escape hatch: when nothing cached matches an
 * article, ask Polymarket's own search, which indexes everything.
 *
 * PRIVACY: this sends words from the user's headline off-device. That is
 * exactly what the local-embedding path promises never to do, so the caller
 * must gate it behind an explicit opt-in — see `searchFallbackEnabled`.
 */
export async function searchMarkets(
  workerUrl: string,
  workerSecret: string,
  query: string,
  limit = 25,
): Promise<PolyMarket[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const res = await fetch(`${workerUrl}/search?${params}`, { headers: authHeaders(workerSecret) })
  if (!res.ok) throw new Error(`search_markets_failed:${res.status}`)
  const raw = (await res.json()) as RawGammaMarket[]
  if (!Array.isArray(raw)) return []
  const out: PolyMarket[] = []
  const seen = new Set<string>()
  for (const m of raw) {
    if (isPerGameSportsMarket(m)) continue
    const parsed = parseGammaMarket(m)
    if (!parsed || parsed.closed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    out.push(parsed)
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
