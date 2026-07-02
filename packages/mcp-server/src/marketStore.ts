import type { CachedMarket, MarketCacheBlob, MarketStore } from '@actually/core'

const CACHE_TTL_MS = 5 * 60_000

/**
 * MarketStore backed by the worker's precomputed /market-cache blob. Caches
 * in-memory for CACHE_TTL_MS so a burst of check_news calls in one agent
 * session doesn't refetch a ~1.6MB blob every time.
 */
export class WorkerMarketStore implements MarketStore {
  private cached: { markets: CachedMarket[]; fetchedAt: number } | null = null

  constructor(
    private readonly workerUrl: string,
    private readonly workerSecret: string,
    private readonly expectedModel: string,
  ) {}

  async getMarkets(): Promise<CachedMarket[]> {
    if (this.cached && Date.now() - this.cached.fetchedAt < CACHE_TTL_MS) {
      return this.cached.markets
    }
    const res = await fetch(`${this.workerUrl}/market-cache`, {
      headers: { 'X-Actually-Auth': this.workerSecret },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`market-cache fetch failed: ${res.status} ${text}`)
    }
    const blob = (await res.json()) as MarketCacheBlob
    if (blob.model !== this.expectedModel) {
      throw new Error(
        `market-cache model mismatch: worker served "${blob.model}", expected "${this.expectedModel}". ` +
          'The precompute script and this server must use the same embedding model.',
      )
    }
    this.cached = { markets: blob.markets, fetchedAt: Date.now() }
    return blob.markets
  }
}
