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
