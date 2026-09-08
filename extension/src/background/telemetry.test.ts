/**
 * Regression coverage for the telemetry queue cap added in Sprint 4.
 * Without the cap, a Worker that's been unreachable for weeks would let
 * `chrome.storage.local.telemetryQueue` grow without bound. The cap drops
 * the oldest events so the queue stays at <= 1000.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../shared/constants'
import type { Settings, TelemetryEvent } from '../shared/types'
import { trackEvent, flushTelemetry } from './telemetry'
import worker from '../../worker/index'

// Minimal in-memory chrome.storage.local stub. The production code only ever
// touches { get, set } against telemetryQueue + installId, so we don't need
// the full API.
function makeStorageStub() {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: vi.fn(async (key: string | string[]) => {
      if (typeof key === 'string') return { [key]: data[key] }
      return Object.fromEntries(key.map((k) => [k, data[k]]))
    }),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(data, patch)
    }),
  }
}

const SETTINGS: Settings = {
  confidenceThreshold: 0.45,
  lowConfidenceFloor: 0.30,
  embeddingProvider: 'local',
  workerUrl: 'https://stub.example/',
  workerSecret: 'stub',
  telemetryEnabled: true,
  searchFallbackEnabled: false,
  searchFallbackOfferDismissed: false,
}

describe('trackEvent - queue cap', () => {
  let storage: ReturnType<typeof makeStorageStub>

  beforeEach(() => {
    storage = makeStorageStub()
    // Pre-seed installId so trackEvent does not try to generate one (which
    // calls crypto.randomUUID - fine in node, but we want determinism).
    storage.data[STORAGE_KEYS.installId] = 'test-install-id'
    // @ts-expect-error - we only stub the surface trackEvent uses.
    globalThis.chrome = { storage: { local: storage } }
  })
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome
  })

  it('grows naturally below the cap', async () => {
    for (let i = 0; i < 50; i++) {
      await trackEvent('match_shown', SETTINGS)
    }
    const queue = storage.data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[]
    expect(queue.length).toBe(50)
  })

  it('drops the oldest entries once it crosses 1000', async () => {
    // Pre-load 999 fake old events so we can prove the boundary.
    const seed: TelemetryEvent[] = Array.from({ length: 999 }, (_, i) => ({
      installId: 'test-install-id',
      event: 'match_shown',
      ts: i,
      meta: { idx: i },
    }))
    storage.data[STORAGE_KEYS.telemetryQueue] = seed

    // Three more events push past 1000 - should evict the first two (idx 0, 1).
    await trackEvent('match_shown', SETTINGS, { idx: 'a' })
    await trackEvent('match_shown', SETTINGS, { idx: 'b' })
    await trackEvent('match_shown', SETTINGS, { idx: 'c' })

    const queue = storage.data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[]
    expect(queue.length).toBe(1000)
    // First two seeded events were dropped; the newest is last.
    expect(queue[0]?.meta?.idx).toBe(2)
    expect(queue[queue.length - 1]?.meta?.idx).toBe('c')
  })

  it('skips entirely when telemetry is disabled', async () => {
    await trackEvent('match_shown', { ...SETTINGS, telemetryEnabled: false })
    expect(storage.data[STORAGE_KEYS.telemetryQueue]).toBeUndefined()
    expect(storage.set).not.toHaveBeenCalled()
  })
})

describe('flushTelemetry - only confirmed-sent events are removed (2026-09-08 audit F07)', () => {
  let storage: ReturnType<typeof makeStorageStub>
  // SETTINGS.workerUrl has a trailing slash, fine for the trackEvent tests
  // above (which never fetch), but flushTelemetry builds `${workerUrl}/telemetry`
  // from it - a trailing slash there would 404 against the real Worker below.
  const FLUSH_SETTINGS: Settings = { ...SETTINGS, workerUrl: 'https://stub.example' }
  const fakeEnv = {
    WORKER_SHARED_SECRET: FLUSH_SETTINGS.workerSecret, // must match what flushTelemetry actually sends
    ALLOWED_EXTENSION_ID: 'test-extension',
    RATE_LIMITER_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  }

  beforeEach(() => {
    storage = makeStorageStub()
    storage.data[STORAGE_KEYS.installId] = 'test-install-id'
    // @ts-expect-error - we only stub the surface these functions use.
    globalThis.chrome = { storage: { local: storage } }
  })
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome
    vi.unstubAllGlobals()
  })

  it('sends a 300-event queue as batches the real Worker actually persists in full, instead of dropping the tail past 250', async () => {
    const queue: TelemetryEvent[] = Array.from({ length: 300 }, (_, i) => ({
      installId: 'test-install-id', event: 'match_shown', ts: i,
    }))
    storage.data[STORAGE_KEYS.telemetryQueue] = queue
    let persisted = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) =>
      worker.fetch(new Request(url, init), {
        ...fakeEnv, TELEMETRY: { writeDataPoint: () => { persisted++ } },
      } as never),
    ))

    await flushTelemetry(FLUSH_SETTINGS)

    expect(persisted).toBe(300)
    expect(storage.data[STORAGE_KEYS.telemetryQueue]).toEqual([])
  })

  it('keeps an event added WHILE the flush request was in flight, instead of wiping the whole queue on success', async () => {
    storage.data[STORAGE_KEYS.telemetryQueue] = [
      { installId: 'test-install-id', event: 'match_shown', ts: 1 },
    ]
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        // Simulate trackEvent() appending a NEW event while THIS request is
        // still in flight - a real race between the two async operations.
        await trackEvent('match_lowconf', FLUSH_SETTINGS, { late: true })
        return Response.json({ ok: true }) // the ORIGINAL event confirms sent
      }
      // The batch containing the late-added event fails - it must not have
      // been wiped already by the first batch's unrelated success.
      return new Response('fail', { status: 500 })
    }))

    await flushTelemetry(FLUSH_SETTINGS)

    const remaining = storage.data[STORAGE_KEYS.telemetryQueue] as TelemetryEvent[]
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.meta?.late).toBe(true)
  })

  it('does not send the same queued events twice from two overlapping flush calls', async () => {
    storage.data[STORAGE_KEYS.telemetryQueue] = [
      { installId: 'test-install-id', event: 'match_shown', ts: 1 },
    ]
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return Response.json({ ok: true })
    }))

    await Promise.all([flushTelemetry(FLUSH_SETTINGS), flushTelemetry(FLUSH_SETTINGS)])

    expect(calls).toBe(1)
  })
})
