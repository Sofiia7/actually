import { POLYMARKET_BASE_URL } from '../shared/constants'

/**
 * Public Polymarket URL. `?utm_source=actually` is for our own UTM analytics
 * only — it does NOT produce on-chain builder attribution. Real attribution
 * happens via builderCode embedded in signed CLOB orders submitted from the
 * Trade tab (see src/background/trade.ts, spec §8).
 */
export function buildMarketUrl(slug: string): string {
  return `${POLYMARKET_BASE_URL}/${slug}?utm_source=actually`
}

/**
 * Link to a market's public Polymarket page. polymarket.com routes on the
 * EVENT slug, so prefer it — passing the market's own slug is what produced
 * "Страница не найдена" on real markets (observed 2026-08-16). Falls back to
 * the market slug when Gamma reported no event (single-market events, older
 * cache entries written before eventSlug was captured), which is still right
 * more often than not.
 */
export function marketPageUrl(market: { slug: string; eventSlug?: string }): string {
  return buildMarketUrl(market.eventSlug || market.slug)
}
