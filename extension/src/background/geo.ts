/**
 * Geo check for the Trade tab.
 *
 * Polymarket is unavailable in several jurisdictions; placing an order from
 * one of them is the user's problem at Polymarket, but as the builder we
 * have an obligation to not actively facilitate it. Discovery is unrestricted
 * - only trading is gated.
 *
 * We resolve the country via the Worker `/geo` endpoint which reads
 * `CF-IPCountry` and returns it alongside a "blocked" flag computed from
 * the canonical blocklist. Result is cached in memory for the lifetime of
 * the popup (not persisted - countries can change between sessions).
 */

/**
 * Defense-in-depth floor for the FULL-block tier only (no new orders, and
 * existing positions cannot be closed either) - comprehensively
 * OFAC-sanctioned jurisdictions. Deliberately NOT the whole restricted-country
 * list: Polymarket's larger close-only tier (Germany, the UK, Brazil, and
 * ~30 others - see the Worker's CLOSE_ONLY_COUNTRIES) changes more often and
 * has no unambiguous single "blocked" answer to hardcode here, so it is
 * Worker-only; the Worker is the source of truth for it at request time.
 * This floor exists so a worker bug or stale/misconfigured deploy can't wave
 * through a country already known to be in the most severe tier.
 */
export const BLOCKED_COUNTRIES = new Set<string>([
  'IR', // Iran
  'KP', // North Korea
  'CU', // Cuba
  'SY', // Syria
])

/** Why a geo check failed, when it failed. */
export type GeoErrorReason =
  | 'no_worker'      // Worker URL or secret not configured
  | 'unauthorized'   // Worker returned 401 - secret mismatch or extension origin not allow-listed
  | 'misconfigured'  // Worker returned 503 - missing env on the Cloudflare side
  | 'rate_limited'   // Worker returned 429
  | 'http_error'     // Other non-2xx response
  | 'network'        // Fetch threw
  | 'no_country'     // Worker responded 200 but didn't include a country code

export interface GeoStatus {
  country: string
  blocked: boolean
  /**
   * True when `blocked` is Polymarket's close-only tier (existing positions
   * can still be closed/sold/cancelled) rather than a full block (2026-09-08
   * audit F08). Meaningless when `blocked` is false. Always false for a
   * country BLOCKED_COUNTRIES itself forces to blocked - floor membership
   * means the full-block tier by construction.
   */
  closeOnly: boolean
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
    cached = { country: '', blocked: true, closeOnly: false, unknown: true, errorReason: 'no_worker' }
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
      cached = { country: '', blocked: true, closeOnly: false, unknown: true, errorReason: reason }
      cachedAt = Date.now()
      return cached
    }
    const data = (await res.json()) as {
      country?: string
      blocked?: boolean
      closeOnly?: boolean
    }
    if (!data.country) {
      cached = { country: '', blocked: true, closeOnly: false, unknown: true, errorReason: 'no_country' }
      cachedAt = Date.now()
      return cached
    }
    const country = data.country.toUpperCase()
    // Floor membership forces the FULL-block tier regardless of what the
    // worker said (see BLOCKED_COUNTRIES's doc comment) - so it also forces
    // closeOnly false, even if a buggy worker claimed close-only for it.
    const onFloor = BLOCKED_COUNTRIES.has(country)
    cached = {
      country,
      // OR the worker's verdict with our own bundled list rather than
      // trusting the worker alone - otherwise BLOCKED_COUNTRIES above is
      // documented as a defense-in-depth floor but doesn't actually enforce
      // anything (its only consumer was its own test file). This makes it a
      // real floor: even a worker bug or a stale/misconfigured deploy can't
      // wave through a country this bundled list already knows is
      // restricted. The worker stays the sole source of truth for anything
      // NOT in this list (close-only tier, OFAC/EXTRA_BLOCKED_COUNTRIES
      // additions, Ontario/BC/AB/QC).
      blocked: Boolean(data.blocked) || onFloor,
      closeOnly: Boolean(data.closeOnly) && !onFloor,
      unknown: false,
    }
    cachedAt = Date.now()
    return cached
  } catch {
    cached = { country: '', blocked: true, closeOnly: false, unknown: true, errorReason: 'network' }
    cachedAt = Date.now()
    return cached
  }
}

/** Used by tests / popup hot-reload. */
export function _resetGeoCache(): void {
  cached = null
  cachedAt = 0
}
