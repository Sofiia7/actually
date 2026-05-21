/**
 * Actually — Service Worker entry.
 *
 * MV3 service workers cannot use dynamic imports and have aggressive lifetime
 * limits, so all heavy work (transformers.js model loading, embedding, cache
 * refresh, matching) happens in the popup context. The SW only handles:
 *   - install/onInstalled hook (installId, alarms)
 *   - settings + history + cache-status messages (storage proxy)
 *   - telemetry flush alarm
 *   - lightweight connection test
 */
import { ALARM_NAMES, CACHE_TTL_MINUTES, TELEMETRY_FLUSH_INTERVAL_MIN, defaultThresholds } from '../shared/constants'
import type { RequestMessage, ResponseMessage } from '../shared/messages'
import type { TestKeysResult } from '../shared/types'
import { getCacheStatus, clearMarketCache } from './cache'
import { getSettings, saveSettings } from './settings'
import { clearHistory, getHistory } from './history'
import { flushTelemetry, getInstallId, trackEvent } from './telemetry'

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create(ALARM_NAMES.flushTelemetry, {
    delayInMinutes: TELEMETRY_FLUSH_INTERVAL_MIN,
    periodInMinutes: TELEMETRY_FLUSH_INTERVAL_MIN,
  })
  // Periodically nudge the popup to refresh stale market cache. The SW
  // itself cannot run embeddings (MV3 lifetime + no DOM), so the alarm
  // just sets a "stale" flag the popup reads on next open. The actual
  // refresh happens in popup operations.maybeRefreshStaleCache().
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
      // Order placement runs in the popup (it needs the WC v2 session and
      // clob client, which can't live in a service worker). The SW just
      // refuses cleanly here so this handler doesn't pretend to work.
      return { type: 'ORDER_RESULT', ok: false, error: 'handled_in_popup' }
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
