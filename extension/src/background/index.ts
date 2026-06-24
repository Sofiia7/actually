/**
 * Actually — Service Worker entry.
 *
 * MV3 service workers cannot use dynamic imports and have aggressive lifetime
 * limits, so all heavy work (transformers.js model loading, embedding, cache
 * refresh, matching, WalletConnect, CLOB signing) happens in the offscreen
 * document — see src/offscreen/offscreen.ts and src/background/offscreen-host.ts.
 *
 * The SW only handles:
 *   - install/onInstalled hook (installId, alarms)
 *   - settings + history + cache-status messages (storage proxy)
 *   - telemetry flush alarm
 *   - lightweight connection test
 *   - forwarding "heavy" messages to the offscreen document
 *
 * v1 architecture is popup-only — no content script. The toolbar icon opens
 * the popup via `default_popup` in manifest.json, and Ctrl/Cmd+Shift+P does
 * the same via the `_execute_action` command (no listener needed when
 * default_popup is set).
 */
import { ALARM_NAMES, CACHE_TTL_MINUTES, TELEMETRY_FLUSH_INTERVAL_MIN, defaultThresholds } from '../shared/constants'
import type { RequestMessage, ResponseMessage } from '../shared/messages'
import type { TestKeysResult } from '../shared/types'
import { getCacheStatus, clearMarketCache } from './cache'
import { getSettings, saveSettings } from './settings'
import { clearHistory, getHistory } from './history'
import { flushTelemetry, getInstallId, trackEvent } from './telemetry'
import { routeToOffscreen } from './offscreen-host'

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create(ALARM_NAMES.flushTelemetry, {
    delayInMinutes: TELEMETRY_FLUSH_INTERVAL_MIN,
    periodInMinutes: TELEMETRY_FLUSH_INTERVAL_MIN,
  })
  // Periodically nudge the popup to refresh stale market cache. The SW
  // itself cannot run embeddings (MV3 lifetime + no DOM), so the alarm
  // just fires a telemetry signal. The actual refresh happens lazily in the
  // offscreen document on the next check (see offscreen.ts maybeRefreshStale).
  chrome.alarms.create(ALARM_NAMES.refreshCache, {
    delayInMinutes: CACHE_TTL_MINUTES,
    periodInMinutes: CACHE_TTL_MINUTES,
  })

  if (details.reason === 'install') {
    await getInstallId()
    const settings = await getSettings()
    await trackEvent('install', settings)
  }
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAMES.flushTelemetry) {
    const settings = await getSettings()
    await flushTelemetry(settings)
    return
  }
  if (alarm.name === ALARM_NAMES.refreshCache) {
    // No-op in SW (we can't load transformers here). The popup will see the
    // cache as stale via TTL check on next open and refresh lazily.
    // Telemetry hook for the "we tried to refresh" signal:
    const settings = await getSettings()
    await trackEvent('cache_refresh', settings, { triggered_by: 'alarm' })
  }
})

// --- Messaging ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: RequestMessage, _sender, sendResponse) => {
  // Storage proxy for the offscreen document. Some Chrome builds don't expose
  // chrome.storage there, so the offscreen shim (storage-bridge.ts) forwards
  // local get/set/remove here, where chrome.storage is always available.
  if (msg && (msg as { type?: string }).type === 'SW_STORAGE') {
    const m = msg as unknown as { op: 'get' | 'set' | 'remove'; keys?: string | string[] | null; items?: Record<string, unknown> }
    const run =
      m.op === 'get'
        ? chrome.storage.local.get(m.keys ?? null)
        : m.op === 'set'
          ? chrome.storage.local.set(m.items ?? {})
          : chrome.storage.local.remove(m.keys ?? [])
    Promise.resolve(run)
      .then((r) => sendResponse(r ?? null))
      .catch((e) => sendResponse({ __storageError: String(e) }))
    return true
  }

  // Offscreen-targeted messages are forwarded to the offscreen document
  // and the response piped back. The SW itself does not interpret them.
  if (msg && (msg as { target?: string }).target === 'offscreen') {
    routeToOffscreen(msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ type: 'OS_ERROR', error: String(err) }))
    return true
  }
  handle(msg)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ type: 'ERROR', error: String(err) } satisfies ResponseMessage))
  return true
})

async function handle(msg: RequestMessage): Promise<ResponseMessage> {
  const settings = await getSettings()

  switch (msg.type) {
    case 'GET_SETTINGS':
      return { type: 'SETTINGS_RESPONSE', settings }

    case 'SAVE_SETTINGS': {
      const prev = settings.embeddingProvider
      const switching = msg.settings.embeddingProvider && msg.settings.embeddingProvider !== prev
      const patch = { ...msg.settings }
      if (switching) {
        const td = defaultThresholds(msg.settings.embeddingProvider!)
        if (patch.confidenceThreshold === undefined) patch.confidenceThreshold = td.confidenceThreshold
        if (patch.lowConfidenceFloor === undefined) patch.lowConfidenceFloor = td.lowConfidenceFloor
      }
      const next = await saveSettings(patch)
      if (switching) await clearMarketCache()
      return { type: 'SETTINGS_RESPONSE', settings: next }
    }

    case 'GET_HISTORY':
      return { type: 'HISTORY_RESPONSE', items: await getHistory() }

    case 'CLEAR_HISTORY':
      await clearHistory()
      return { type: 'OK' }

    case 'GET_CACHE_STATUS': {
      const s = await getCacheStatus()
      return { type: 'CACHE_STATUS', count: s.count, lastUpdated: s.lastUpdated, refreshing: false }
    }

    case 'TEST_KEYS':
      return { type: 'TEST_KEYS_RESULT', result: await testConnection() }

    // EXTRACT_AND_MATCH and REFRESH_CACHE_NOW are handled in the popup.
    case 'EXTRACT_AND_MATCH':
    case 'REFRESH_CACHE_NOW':
      return { type: 'ERROR', error: 'handled_in_popup' }

    case 'PLACE_ORDER': {
      // Order placement runs in the offscreen document (it needs the WC v2
      // session and clob client, which can't live in a service worker). The
      // SW just refuses cleanly here — clients should send the OS_PLACE_ORDER
      // offscreen message instead.
      return { type: 'ORDER_RESULT', ok: false, error: 'handled_in_offscreen' }
    }

    default:
      return { type: 'ERROR', error: 'unknown_message' }
  }
}

async function testConnection(): Promise<TestKeysResult> {
  const settings = await getSettings()
  const out: TestKeysResult = { worker: { ok: false } }

  if (!settings.workerUrl) {
    out.worker = { ok: false, error: 'no_url' }
    return out
  }

  try {
    const res = await fetch(`${settings.workerUrl}/health`)
    out.worker = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
  } catch (err) {
    out.worker = { ok: false, error: String(err) }
  }

  if (settings.embeddingProvider === 'openai' && out.worker.ok) {
    try {
      const res = await fetch(`${settings.workerUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actually-Auth': settings.workerSecret,
        },
        body: JSON.stringify({ texts: ['ping'] }),
      })
      out.openai = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
    } catch (err) {
      out.openai = { ok: false, error: String(err) }
    }
  }
  return out
}
