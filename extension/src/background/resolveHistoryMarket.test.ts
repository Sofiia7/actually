/**
 * Coverage for History's "trade this again" lookup — cache-first, Gamma
 * fallback, and the closed/expired guard that stops a stale History entry
 * from re-opening a dead market for trading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../shared/constants'
import type { CachedMarket, PolyMarket } from '@actually/core'
import { resolveHistoryMarket } from './resolveHistoryMarket'

function makeStorageStub(seed: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...seed }
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

function makeMarket(overrides: Partial<PolyMarket> = {}): PolyMarket {
  return {
    id: 'm1',
    slug: 'will-x-happen',
    question: 'Will X happen?',
    outcomePrices: '["0.6","0.4"]',
    outcomes: '["Yes","No"]',
    volume: 1000,
    liquidity: 500,
    active: true,
    closed: false,
    clobTokenIds: ['tok-yes', 'tok-no'],
    ...overrides,
  }
}

describe('resolveHistoryMarket', () => {
  const ORIGINAL_FETCH = global.fetch

  beforeEach(() => {
    // @ts-expect-error — stub only the surface getMarketCache uses.
    globalThis.chrome = { storage: { local: makeStorageStub() } }
  })
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome
    global.fetch = ORIGINAL_FETCH
    vi.restoreAllMocks()
  })

  it('resolves from the cache without ever calling fetch', async () => {
    const market: CachedMarket = { ...makeMarket(), embeddingB64: '', questionHash: 'h', cachedAt: 0 }
    // @ts-expect-error — test-only storage stub.
    globalThis.chrome.storage.local.data[STORAGE_KEYS.marketCache] = [market]
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    const result = await resolveHistoryMarket('m1', 'https://worker.example', 'secret')

    expect(result).toEqual({ ok: true, market: expect.objectContaining({ id: 'm1' }) })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to a direct Gamma fetch when the market fell out of the cache', async () => {
    const market = makeMarket({ id: 'm2' })
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [market],
    })) as unknown as typeof fetch

    const result = await resolveHistoryMarket('m2', 'https://worker.example', 'secret')

    expect(result).toEqual({ ok: true, market: expect.objectContaining({ id: 'm2' }) })
  })

  it('returns not_found when neither the cache nor Gamma has the market', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => [] })) as unknown as typeof fetch

    const result = await resolveHistoryMarket('missing', 'https://worker.example', 'secret')

    expect(result).toEqual({ ok: false, error: 'not_found' })
  })

  it('refuses a market marked closed', async () => {
    const market: CachedMarket = { ...makeMarket({ closed: true }), embeddingB64: '', questionHash: 'h', cachedAt: 0 }
    // @ts-expect-error — test-only storage stub.
    globalThis.chrome.storage.local.data[STORAGE_KEYS.marketCache] = [market]

    const result = await resolveHistoryMarket('m1', 'https://worker.example', 'secret')

    expect(result).toEqual({ ok: false, error: 'closed' })
  })

  it('refuses a market whose endDate has already passed, even if closed is still false', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const market: CachedMarket = {
      ...makeMarket({ endDate: past }),
      embeddingB64: '',
      questionHash: 'h',
      cachedAt: 0,
    }
    // @ts-expect-error — test-only storage stub.
    globalThis.chrome.storage.local.data[STORAGE_KEYS.marketCache] = [market]

    const result = await resolveHistoryMarket('m1', 'https://worker.example', 'secret')

    expect(result).toEqual({ ok: false, error: 'closed' })
  })
})
