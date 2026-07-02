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
    const raw = (await res.json()) as Array<Partial<PolyMarket> & {
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
    }>
    if (raw.length === 0) break
    for (const m of raw) {
      if (!m.id || !m.question || !m.outcomePrices || !m.outcomes) continue
      const id = String(m.id)
      if (seenIds.has(id)) continue
      seenIds.add(id)
      out.push({
        id,
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
      })
      if (out.length >= total) return out
    }
  }
  return out
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
