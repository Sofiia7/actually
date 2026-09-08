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

// Matches the Worker's own TELEMETRY_LIMITS (extension/worker/index.ts) -
// events.slice(0, maxEvents) there silently drops anything past 250 in a
// single request, and a request over maxBodyBytes gets a soft `{ok:true}`
// with nothing saved. Sending the whole queue in one shot let the client
// wipe events the Worker never actually persisted (2026-09-08 audit F07: a
// 300-event queue sent as one request left 250 saved, 300 deleted).
// Batching client-side means the Worker's own per-request caps are never
// actually hit, so a 200 response really does mean everything IN that
// request was accepted.
const MAX_BATCH_EVENTS = 250
const MAX_BATCH_BYTES = 48 * 1024 // margin under the Worker's 64KB cap

/** Take a prefix of `queue` that fits within one batch's count/byte budget. */
function takeBatch(queue: TelemetryEvent[]): TelemetryEvent[] {
  const batch: TelemetryEvent[] = []
  let bytes = 2 // rough allowance for the enclosing `[]`
  for (const ev of queue) {
    if (batch.length >= MAX_BATCH_EVENTS) break
    const evBytes = JSON.stringify(ev).length + 1
    if (batch.length > 0 && bytes + evBytes > MAX_BATCH_BYTES) break
    batch.push(ev)
    bytes += evBytes
  }
  // A single pathological event bigger than the whole budget still has to
  // go somewhere, rather than spinning flushTelemetry's loop forever on it.
  if (batch.length === 0 && queue.length > 0) batch.push(queue[0])
  return batch
}

// Serializes concurrent flush calls (e.g. an alarm firing while a manual
// "check now" is already flushing) so two of them can never race the same
// read-batch-send-remove sequence against each other (2026-09-08 audit F07).
let flushInFlight: Promise<void> | null = null

export async function flushTelemetry(settings: Settings): Promise<void> {
  if (!settings.telemetryEnabled || !settings.workerUrl) return
  if (flushInFlight) return flushInFlight
  flushInFlight = doFlush(settings).finally(() => {
    flushInFlight = null
  })
  return flushInFlight
}

async function doFlush(settings: Settings): Promise<void> {
  for (;;) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue)
    const queue = (data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[] | undefined) ?? []
    if (queue.length === 0) return
    const batch = takeBatch(queue)
    try {
      const res = await fetch(`${settings.workerUrl}/telemetry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actually-Auth': settings.workerSecret,
        },
        body: JSON.stringify({ events: batch }),
      })
      if (!res.ok) return // keep queue, retry next flush
    } catch {
      return // keep queue, retry next flush
    }
    // Confirmed sent - remove exactly this batch from the CURRENT queue
    // (re-read, not the snapshot above), so an event trackEvent() appended
    // while the request was in flight survives instead of being wiped by a
    // blind reset to [] (2026-09-08 audit F07).
    const fresh = await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue)
    const freshQueue = (fresh[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[] | undefined) ?? []
    await chrome.storage.local.set({ [STORAGE_KEYS.telemetryQueue]: freshQueue.slice(batch.length) })
  }
}
