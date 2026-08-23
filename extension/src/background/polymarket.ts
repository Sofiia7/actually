import { POLYMARKET_BASE_URL } from '../shared/constants'

/**
 * Public Polymarket URL. `?utm_source=actually` is for our own UTM analytics
 * only - it does NOT produce on-chain builder attribution. Real attribution
 * happens via builderCode embedded in signed CLOB orders submitted from the
 * Trade tab (see src/background/trade.ts, spec §8).
 */
export function buildMarketUrl(slug: string): string {
  return `${POLYMARKET_BASE_URL}/${slug}?utm_source=actually`
}

/**
 * Link to a market's public Polymarket page. polymarket.com routes on the
 * EVENT slug, so prefer it - passing the market's own slug is what produced
 * "Страница не найдена" on real markets (observed 2026-08-16). Falls back to
 * the market slug when Gamma reported no event (single-market events, older
 * cache entries written before eventSlug was captured), which is still right
 * more often than not.
 */
export function marketPageUrl(market: { slug: string; eventSlug?: string }): string {
  return buildMarketUrl(market.eventSlug || market.slug)
}

/**
 * Polymarket's own search, seeded with a headline.
 *
 * Offered when Check finds nothing tradeable. Our cache holds only OPEN
 * markets, so "nothing matched" cannot distinguish "Polymarket never ran one"
 * from "it ran several and they all resolved" - and the second is common for
 * news that reports on an outcome rather than predicting one. Polymarket's
 * search covers resolved markets, so it can answer what we can't.
 *
 * Stopwords are dropped and the query capped at six terms: a whole headline
 * pasted into a search box matches nothing.
 */
export function polymarketSearchUrl(headline: string, maxTerms = 6): string {
  const terms = (headline.toLowerCase().match(/[a-z][a-z']{3,}/g) ?? [])
    .filter((w) => !SEARCH_STOPWORDS.has(w))
    .slice(0, maxTerms)
  const q = terms.length > 0 ? terms.join(' ') : headline.slice(0, 60)
  // Origin, not POLYMARKET_BASE_URL - that constant already ends in /event
  // (markets route through it), and /event/search is a 404.
  const origin = new URL(POLYMARKET_BASE_URL).origin
  return `${origin}/search?q=${encodeURIComponent(q)}&utm_source=actually`
}

const SEARCH_STOPWORDS = new Set([
  'about', 'after', 'against', 'been', 'before', 'being', 'between', 'both', 'could', 'does',
  'doing', 'during', 'each', 'from', 'have', 'having', 'here', 'into', 'itself', 'more',
  'most', 'only', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your',
])
