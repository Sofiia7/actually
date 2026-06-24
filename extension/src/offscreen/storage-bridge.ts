/**
 * chrome.storage bridge for the offscreen document.
 *
 * Some Chrome builds expose only a limited API surface to offscreen documents,
 * with `chrome.storage` left undefined. All of our persistence (settings,
 * market cache, history, telemetry) lives in chrome.storage.local and is reached
 * from here via the background/* modules. When the native API is missing we
 * install a chrome.storage.local-compatible shim that proxies get/set/remove to
 * the service worker (which always has chrome.storage), so the callers in
 * background/* stay unchanged.
 *
 * No-op when chrome.storage is natively available, so it is safe to always call.
 */
type StorageMsg =
  | { type: 'SW_STORAGE'; op: 'get'; keys?: string | string[] | null }
  | { type: 'SW_STORAGE'; op: 'set'; items: Record<string, unknown> }
  | { type: 'SW_STORAGE'; op: 'remove'; keys: string | string[] }

async function call(msg: StorageMsg): Promise<unknown> {
  const r = await chrome.runtime.sendMessage(msg)
  if (r && typeof r === 'object' && '__storageError' in (r as object)) {
    throw new Error((r as { __storageError: string }).__storageError)
  }
  return r
}

export function installStorageBridge(): void {
  const c = chrome as unknown as { storage?: { local?: unknown } }
  if (c.storage && c.storage.local) return // native API present — nothing to do
  c.storage = {
    local: {
      get: (keys?: string | string[] | null) =>
        call({ type: 'SW_STORAGE', op: 'get', keys: keys ?? null }),
      set: (items: Record<string, unknown>) =>
        call({ type: 'SW_STORAGE', op: 'set', items }),
      remove: (keys: string | string[]) =>
        call({ type: 'SW_STORAGE', op: 'remove', keys }),
    },
  } as unknown as typeof chrome.storage
}
