/**
 * Trading jurisdiction gate for the MCP server's real-money tools.
 *
 * The extension refuses to trade from a Polymarket-restricted jurisdiction
 * because, as the builder, we have an obligation to not actively facilitate
 * it (see extension/src/background/geo.ts) — discovery stays unrestricted,
 * only order placement is gated. This server signs and submits real orders
 * with the same builder code attached, so it carries the same obligation,
 * but until now had no equivalent check at all. This calls the same worker
 * `/geo` endpoint the extension uses, which resolves the jurisdiction of
 * whoever is actually making the request — here, wherever this server
 * process runs.
 *
 * Fails closed: any error (network, auth, misconfigured, missing country)
 * is treated as blocked, matching the extension's posture.
 */

export interface GeoGateResult {
  blocked: boolean
  country?: string
}

const CACHE_TTL_MS = 5 * 60_000

let cached: GeoGateResult | null = null
let cachedAt = 0

export async function checkTradingGeoGate(workerUrl: string, workerSecret: string): Promise<GeoGateResult> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached

  let result: GeoGateResult
  try {
    const res = await fetch(`${workerUrl}/geo`, { headers: { 'X-Actually-Auth': workerSecret } })
    if (!res.ok) {
      result = { blocked: true }
    } else {
      const data = (await res.json()) as { country?: string; blocked?: boolean }
      // Require `blocked` to actually be a boolean rather than coercing a
      // missing field with `Boolean(undefined)` (=== false) — a future
      // worker refactor that renames/drops the field would otherwise
      // silently disable the jurisdiction gate for every installed copy of
      // this package with no error anywhere. Fail closed instead.
      result =
        data.country && typeof data.blocked === 'boolean'
          ? { blocked: data.blocked, country: data.country.toUpperCase() }
          : { blocked: true, country: data.country?.toUpperCase() }
    }
  } catch {
    result = { blocked: true }
  }

  cached = result
  cachedAt = Date.now()
  return result
}

/** Used by tests. */
export function _resetTradingGeoGateCache(): void {
  cached = null
  cachedAt = 0
}
