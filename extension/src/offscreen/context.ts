/**
 * Which extension context is this code running in?
 *
 * Lives in its own module, free of the offscreen router's heavy imports
 * (WalletConnect, the CLOB SDK, transformers.js), so the guard can be unit
 * tested without dragging that graph — and, more importantly, so the check
 * itself can never accidentally depend on something that only loads in one
 * context.
 */

/** Path of the offscreen document, relative to the extension root. */
const OFFSCREEN_PATH = '/offscreen/offscreen.html'

/**
 * True only in the real offscreen document.
 *
 * THIS GUARD IS LOAD-BEARING. `offscreen.ts` registers a global
 * `chrome.runtime.onMessage` listener at import time, and the bundler places
 * its entry chunk in the popup page and the service worker as well — the popup
 * statically imports `background/*` modules that share that graph, so
 * `dist/src/popup/index.html` ends up loading the very same offscreen chunk.
 *
 * `routeToOffscreen` forwards requests with `chrome.runtime.sendMessage`, which
 * is a BROADCAST delivered to every extension context except the sender. With
 * the listener live in more than one context, every offscreen request was
 * handled more than once: connect ran twice (two SignClients, two pairings, two
 * QR codes — the wallet scans one and the other proposal is orphaned, so it
 * spins forever), the wallet was asked to sign twice, and a placed order could
 * be submitted twice.
 */
export function isOffscreenDocument(pathname: string | undefined): boolean {
  return typeof pathname === 'string' && pathname.endsWith(OFFSCREEN_PATH)
}

/** Evaluated against the live `location`, with contexts that have none (the
 * service worker in some builds) treated as "not the offscreen document". */
export function runningInOffscreenDocument(): boolean {
  return typeof location !== 'undefined' && isOffscreenDocument(location.pathname)
}
