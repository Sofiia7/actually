import { DEFAULT_FETCH_TIMEOUT_MS, type CachedMarket, type MarketCacheBlob, type MarketStore } from '@actually/core'

const CACHE_TTL_MS = 5 * 60_000

/**
 * MarketStore backed by the worker's precomputed /market-cache blob. Caches
 * in-memory for CACHE_TTL_MS so a burst of check_news calls in one agent
 * session doesn't refetch a ~1.6MB blob every time.
 */
export class WorkerMarketStore implements MarketStore {
  private cached: { markets: CachedMarket[]; fetchedAt: number } | null = null
  private inFlight: Promise<CachedMarket[]> | null = null
  private builtAt: number | null = null

  constructor(
    private readonly workerUrl: string,
    private readonly workerSecret: string,
    private readonly expectedModel: string,
  ) {}

  /**
   * The last successfully-fetched blob's own `builtAt` - the DATA's age, not
   * when this store last polled (see `CACHE_TTL_MS`'s in-memory poll cache
   * above, a different concern). Null before any successful fetch. Lets a
   * caller warn when the precompute cron has likely stopped running instead
   * of silently serving arbitrarily old data (2026-09-08 audit F04).
   */
  getBuiltAt(): number | null {
    return this.builtAt
  }

  async getMarkets(): Promise<CachedMarket[]> {
    if (this.cached && Date.now() - this.cached.fetchedAt < CACHE_TTL_MS) {
      return this.cached.markets
    }
    // Concurrent callers during a cache miss share one fetch instead of each
    // firing their own request against the worker (which rate-limits
    // /market-cache GETs to 20/window).
    if (!this.inFlight) {
      this.inFlight = this.fetchAndCache().finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async fetchAndCache(): Promise<CachedMarket[]> {
    // Bounded, so a hung connection fails cleanly instead of leaving
    // getMarkets() (and the inFlight dedupe guard blocking calls behind it)
    // hanging indefinitely (2026-09-08 audit F17).
    const res = await fetch(`${this.workerUrl}/market-cache`, {
      headers: { 'X-Actually-Auth': this.workerSecret },
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`market-cache fetch failed: ${res.status} ${text}`)
    }
    const blob = (await res.json().catch((err) => {
      throw new Error(`market-cache response was not valid JSON: ${String(err)}`)
    })) as MarketCacheBlob
    if (blob.model !== this.expectedModel) {
      throw new Error(
        `market-cache model mismatch: worker served "${blob.model}", expected "${this.expectedModel}". ` +
          'The precompute script and this server must use the same embedding model.',
      )
    }
    this.cached = { markets: blob.markets, fetchedAt: Date.now() }
    this.builtAt = blob.builtAt
    return blob.markets
  }
}
