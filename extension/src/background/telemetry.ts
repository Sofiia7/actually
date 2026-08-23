import type { Settings, TelemetryEvent } from '../shared/types'
import { STORAGE_KEYS } from '../shared/constants'
import { uuid } from '@actually/core'

export async function getInstallId(): Promise<string> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.installId)
  let id = data[STORAGE_KEYS.installId] as string | undefined
  if (!id) {
    id = uuid()
    await chrome.storage.local.set({ [STORAGE_KEYS.installId]: id })
  }
  return id
}

/**
 * Upper bound on the locally-queued telemetry events. If the Worker is
 * unreachable for a long time we keep dropping the oldest events rather than
 * filling chrome.storage.local without limit. 1000 entries comfortably covers
 * weeks of normal use.
 */
const MAX_QUEUED_EVENTS = 1000

export async function trackEvent(
  event: TelemetryEvent['event'],
  settings: Settings,
  meta?: TelemetryEvent['meta'],
): Promise<void> {
  if (!settings.telemetryEnabled) return
  const installId = await getInstallId()
  const data = await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue)
  const queue = (data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[] | undefined) ?? []
  queue.push({ installId, event, ts: Date.now(), meta })
  // Keep only the most recent MAX_QUEUED_EVENTS - older events are the
  // first to drop when flush has been failing.
  const trimmed =
    queue.length > MAX_QUEUED_EVENTS
      ? queue.slice(queue.length - MAX_QUEUED_EVENTS)
      : queue
  await chrome.storage.local.set({ [STORAGE_KEYS.telemetryQueue]: trimmed })
}

export async function flushTelemetry(settings: Settings): Promise<void> {
  if (!settings.telemetryEnabled || !settings.workerUrl) return
  const data = await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue)
  const queue = (data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[] | undefined) ?? []
  if (queue.length === 0) return
  try {
    const res = await fetch(`${settings.workerUrl}/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actually-Auth': settings.workerSecret,
      },
      body: JSON.stringify({ events: queue }),
    })
    if (res.ok) {
      await chrome.storage.local.set({ [STORAGE_KEYS.telemetryQueue]: [] })
    }
  } catch {
    // keep queue, retry next flush
  }
}
