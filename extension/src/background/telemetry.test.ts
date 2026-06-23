/**
 * Regression coverage for the telemetry queue cap added in Sprint 4.
 * Without the cap, a Worker that's been unreachable for weeks would let
 * `chrome.storage.local.telemetryQueue` grow without bound. The cap drops
 * the oldest events so the queue stays at <= 1000.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../shared/constants'
import type { Settings, TelemetryEvent } from '../shared/types'
import { trackEvent } from './telemetry'

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
}

describe('trackEvent — queue cap', () => {
  let storage: ReturnType<typeof makeStorageStub>

  beforeEach(() => {
    storage = makeStorageStub()
    // Pre-seed installId so trackEvent does not try to generate one (which
    // calls crypto.randomUUID — fine in node, but we want determinism).
    storage.data[STORAGE_KEYS.installId] = 'test-install-id'
    // @ts-expect-error — we only stub the surface trackEvent uses.
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

    // Three more events push past 1000 — should evict the first two (idx 0, 1).
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
