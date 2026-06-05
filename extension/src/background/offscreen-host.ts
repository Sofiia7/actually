/**
 * Offscreen document lifecycle + message routing.
 *
 * MV3 service workers can be evicted at any time; the offscreen
 * document survives independently as long as Chrome's idle timeout
 * hasn't fired. We lazily create the offscreen on the first heavy-op
 * request, then keep it alive by re-using it for subsequent requests.
 */
const OFFSCREEN_URL = 'src/offscreen/offscreen.html'

let creating: Promise<void> | null = null

/**
 * Ensure the offscreen document exists. Idempotent across concurrent
 * callers — the second caller waits on the in-flight create.
 */
export async function ensureOffscreen(): Promise<void> {
  // Chrome 116+ exposes hasDocument; older builds need a manual check
  // via the contexts API.
  const exists = await offscreenExists()
  if (exists) return
  if (creating) {
    await creating
    return
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [
        // The closest justification to what we actually do — heavy
        // background work (embeddings, WC, signing) that the SW
        // cannot host. Chrome accepts WORKERS for this.
        chrome.offscreen.Reason.WORKERS,
      ],
      justification:
        'Run transformers.js embeddings, WalletConnect v2 session, and Polymarket CLOB order signing — all of which need full Web APIs that MV3 service workers do not expose.',
    })
    .finally(() => {
      creating = null
    })
  await creating
}

async function offscreenExists(): Promise<boolean> {
  // Preferred: getContexts (Chrome 116+)
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })
    return ctxs.length > 0
  } catch {
    // Fallback for older Chrome — try create; if it throws "already
    // exists", we're good.
    try {
      return (await chrome.offscreen.hasDocument?.()) ?? false
    } catch {
      return false
    }
  }
}

/**
 * Forward a request whose `target === 'offscreen'` to the offscreen
 * document and return its response. The forward is wrapped in a
 * distinct envelope shape (`__forward: true`) so that only the
 * offscreen listener picks it up — avoids the rebroadcast race
 * where the SW would otherwise receive its own forward.
 */
export async function routeToOffscreen<T = unknown>(msg: unknown): Promise<T> {
  await ensureOffscreen()
  return (await chrome.runtime.sendMessage({ __forward: true, payload: msg })) as T
}
