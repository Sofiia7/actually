/**
 * Can this build redeem in-app at all?
 *
 * Redeeming goes through Polymarket's relayer, which requires builder API
 * credentials. Those live on the Worker (see worker/index.ts's /builder-sign
 * - they must never ship inside the extension), so whether the feature works
 * is a property of the deployment, not of the build. Asking the Worker means
 * the button appears the moment the credentials are configured, with no new
 * release.
 *
 * Failure is treated as "not available": showing Redeem when we could not
 * confirm it works ends in a wallet signature spent on a request the relayer
 * answers with 401.
 */
import { getSettings } from './settings'

let cached: { value: boolean; at: number } | null = null
const TTL_MS = 5 * 60_000

export async function isInAppRedeemAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value
  const settings = await getSettings()
  if (!settings.workerUrl || !settings.workerSecret) return false
  try {
    const res = await fetch(`${settings.workerUrl.replace(/\/$/, '')}/builder-status`, {
      headers: { 'X-Actually-Auth': settings.workerSecret },
    })
    if (!res.ok) {
      cached = { value: false, at: Date.now() }
      return false
    }
    const data = (await res.json()) as { configured?: unknown }
    const value = data.configured === true
    cached = { value, at: Date.now() }
    return value
  } catch {
    return false
  }
}

/** Test seam / used after settings change. */
export function _resetBuilderStatusCache(): void {
  cached = null
}
