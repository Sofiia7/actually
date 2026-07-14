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

/** Why a geo check failed, when it failed. */
export type GeoErrorReason =
  | 'no_worker'      // Worker URL or secret not configured
  | 'unauthorized'   // Worker returned 401 — secret mismatch or extension origin not allow-listed
  | 'misconfigured'  // Worker returned 503 — missing env on the Cloudflare side
  | 'rate_limited'   // Worker returned 429
  | 'http_error'     // Other non-2xx response
  | 'network'        // Fetch threw
  | 'no_country'     // Worker responded 200 but didn't include a country code

export interface GeoStatus {
  country: string
  blocked: boolean
  /** True if the lookup couldn't be performed. See `errorReason` for why. */
  unknown: boolean
  errorReason?: GeoErrorReason
}

/**
 * How long a cached verdict is trusted before `connectWallet`/`placeOrder`'s
 * "independent" geo checks force a fresh lookup. The offscreen document
 * (where this cache lives) is kept alive by Chrome across popup opens, so
 * without a TTL a single verdict from early in a long session could silently
 * outlive a location/VPN change. Short enough to catch that within one
 * trading session, long enough that opening the Trade tab repeatedly doesn't
 * re-hit the Worker every time.
 */
export const GEO_CACHE_TTL_MS = 5 * 60_000

let cached: GeoStatus | null = null
let cachedAt = 0

export async function getGeoStatus(
  workerUrl: string,
  workerSecret: string,
): Promise<GeoStatus> {
  if (cached && Date.now() - cachedAt < GEO_CACHE_TTL_MS) return cached
  if (!workerUrl || !workerSecret) {
    cached = { country: '', blocked: true, unknown: true, errorReason: 'no_worker' }
    cachedAt = Date.now()
    return cached
  }
  try {
    const res = await fetch(`${workerUrl}/geo`, {
      headers: { 'X-Actually-Auth': workerSecret },
    })
    if (!res.ok) {
      const reason: GeoErrorReason =
        res.status === 401 ? 'unauthorized'
        : res.status === 503 ? 'misconfigured'
        : res.status === 429 ? 'rate_limited'
        : 'http_error'
      cached = { country: '', blocked: true, unknown: true, errorReason: reason }
      cachedAt = Date.now()
      return cached
    }
    const data = (await res.json()) as {
      country?: string
      blocked?: boolean
    }
    if (!data.country) {
      cached = { country: '', blocked: true, unknown: true, errorReason: 'no_country' }
      cachedAt = Date.now()
      return cached
    }
    cached = {
      country: data.country.toUpperCase(),
      blocked: Boolean(data.blocked),
      unknown: false,
    }
    cachedAt = Date.now()
    return cached
  } catch {
    cached = { country: '', blocked: true, unknown: true, errorReason: 'network' }
    cachedAt = Date.now()
    return cached
  }
}

/** Used by tests / popup hot-reload. */
export function _resetGeoCache(): void {
  cached = null
  cachedAt = 0
}
