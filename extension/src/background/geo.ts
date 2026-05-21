/**
 * Geo check for the Trade tab.
 *
 * Polymarket is unavailable in several jurisdictions; placing an order from
 * one of them is the user's problem at Polymarket, but as the builder we
 * have an obligation to not actively facilitate it. Discovery is unrestricted
 * — only trading is gated.
 *
 * We resolve the country via the Worker `/geo` endpoint which reads
 * `CF-IPCountry` and returns it alongside a "blocked" flag computed from
 * the canonical blocklist. Result is cached in memory for the lifetime of
 * the popup (not persisted — countries can change between sessions).
 */

export const BLOCKED_COUNTRIES = new Set<string>([
  'US', // United States
  'GB', // United Kingdom
  'FR', // France
  'BE', // Belgium
  'AU', // Australia
  'SG', // Singapore
  'TH', // Thailand
  'TW', // Taiwan
  'PL', // Poland
  // Ontario (Canada) is restricted but country-level data is too coarse to
  // express. Worker handles ON sub-region when CF returns the region header.
])

export interface GeoStatus {
  country: string
  blocked: boolean
  /** True if the lookup failed — fail-closed: treat as blocked. */
  unknown: boolean
}

let cached: GeoStatus | null = null

export async function getGeoStatus(
  workerUrl: string,
  workerSecret: string,
): Promise<GeoStatus> {
  if (cached) return cached
  try {
    const res = await fetch(`${workerUrl}/geo`, {
      headers: { 'X-Actually-Auth': workerSecret },
    })
    if (!res.ok) {
      cached = { country: '', blocked: true, unknown: true }
      return cached
    }
    const data = (await res.json()) as {
      country?: string
      blocked?: boolean
    }
    cached = {
      country: (data.country ?? '').toUpperCase(),
      blocked: Boolean(data.blocked),
      unknown: !data.country,
    }
    return cached
  } catch {
    cached = { country: '', blocked: true, unknown: true }
    return cached
  }
}

/** Used by tests / popup hot-reload. */
export function _resetGeoCache(): void {
  cached = null
}
