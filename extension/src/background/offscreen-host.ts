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
 * callers - the second caller waits on the in-flight create.
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
        // The closest justification to what we actually do - heavy
        // background work (embeddings, WC, signing) that the SW
        // cannot host. Chrome accepts WORKERS for this.
        chrome.offscreen.Reason.WORKERS,
      ],
      justification:
        'Run transformers.js embeddings, WalletConnect v2 session, and Polymarket CLOB order signing - all of which need full Web APIs that MV3 service workers do not expose.',
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
    // Fallback for older Chrome - try create; if it throws "already
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
 * offscreen listener picks it up - avoids the rebroadcast race
 * where the SW would otherwise receive its own forward.
 */
/** Cleared whenever the document is (re)created or found missing. */
let offscreenReady = false

/** Test seam: forget that a document was ever confirmed listening. */
export function _resetOffscreenReady(): void {
  offscreenReady = false
}

const READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 120

function isMissingReceiver(err: unknown): boolean {
  return /receiving end does not exist|could not establish connection/i.test(
    err instanceof Error ? err.message : String(err),
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until the document is actually listening.
 *
 * `chrome.offscreen.createDocument` resolves when the document exists, not
 * when the script inside it has evaluated and registered its message listener.
 * Ours is a 2.4 MB bundle - transformers.js, WalletConnect, the CLOB client -
 * so that gap is long enough to lose the first message through it, which comes
 * back as Chrome's "Receiving end does not exist" and reads, upstream, as a
 * connect that failed for no reason. OS_PING/OS_PONG was built for this and
 * was never called by anything.
 */
async function waitForOffscreen(pollMs: number, timeoutMs: number): Promise<void> {
  if (offscreenReady) return
  const startedAt = Date.now()
  for (;;) {
    try {
      const res = (await chrome.runtime.sendMessage({
        __forward: true,
        payload: { target: 'offscreen', type: 'OS_PING' },
      })) as { type?: string } | undefined
      if (res?.type === 'OS_PONG') {
        offscreenReady = true
        return
      }
    } catch (err) {
      if (!isMissingReceiver(err)) throw err
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('offscreen_not_ready: the offscreen document never started listening')
    }
    await sleep(pollMs)
  }
}

export async function routeToOffscreen<T = unknown>(
  msg: unknown,
  opts: { pollMs?: number; readyTimeoutMs?: number } = {},
): Promise<T> {
  const pollMs = opts.pollMs ?? READY_POLL_MS
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
  await ensureOffscreen()
  await waitForOffscreen(pollMs, readyTimeoutMs)
  try {
    return (await chrome.runtime.sendMessage({ __forward: true, payload: msg })) as T
  } catch (err) {
    // Chrome tears an idle offscreen document down on its own schedule, so a
    // document that answered a moment ago can be gone by the next message.
    // Rebuild it and send once more before giving up on the user's click.
    if (!isMissingReceiver(err)) throw err
    offscreenReady = false
    await ensureOffscreen()
    await waitForOffscreen(pollMs, readyTimeoutMs)
    return (await chrome.runtime.sendMessage({ __forward: true, payload: msg })) as T
  }
}
