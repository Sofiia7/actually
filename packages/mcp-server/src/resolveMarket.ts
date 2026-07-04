import type { MarketStore, PolyMarket } from '@actually/core'

export interface ResolveMarketDeps {
  store: MarketStore
  /** Gamma fallback for a marketId outside the precomputed cache's top-N-by-volume cut. */
  fetchMarketById: (marketId: string) => Promise<PolyMarket | null>
}

/**
 * Single lookup path shared by get_market/place_order/sell_order — cache
 * first, Gamma fallback on miss. Centralizing this means a marketId a caller
 * got from check_news's alternatives (which aren't guaranteed to be in the
 * cache either — they come FROM the cache, so they always are, but a
 * user-supplied marketId from outside the flow might not be) resolves the
 * same way everywhere.
 */
export async function resolveMarket(deps: ResolveMarketDeps, marketId: string): Promise<PolyMarket | null> {
  const cached = await deps.store.getMarkets()
  const hit = cached.find((m) => m.id === marketId)
  if (hit) return hit
  return deps.fetchMarketById(marketId)
}
