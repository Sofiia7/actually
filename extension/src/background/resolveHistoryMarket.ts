import type { PolyMarket } from '@actually/core'
import { fetchMarketById } from '@actually/core'
import { getMarketCache } from './cache'

export type ResolveHistoryMarketResult =
  | { ok: true; market: PolyMarket }
  | { ok: false; error: 'not_found' | 'closed' }

/**
 * Resolve a market by id for History's "trade this again" flow - cache first
 * (fast, no network), then a direct Gamma fetch for a market that's since
 * fallen outside the cache's top-N-by-volume cut. Distinct from the Check
 * flow's matcher: there's no article text to score against here, the user
 * already picked this exact market by clicking a History row.
 */
export async function resolveHistoryMarket(
  marketId: string,
  workerUrl: string,
  workerSecret: string,
): Promise<ResolveHistoryMarketResult> {
  const cache = await getMarketCache()
  const cached = cache.find((m) => m.id === marketId)
  const market = cached ?? (await fetchMarketById(marketId, workerUrl, workerSecret))
  if (!market) return { ok: false, error: 'not_found' }

  const expired = market.endDate != null && Date.parse(market.endDate) < Date.now()
  if (market.closed || expired) return { ok: false, error: 'closed' }

  return { ok: true, market }
}
