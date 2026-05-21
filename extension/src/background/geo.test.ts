import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED_COUNTRIES, _resetGeoCache, getGeoStatus } from './geo'

describe('BLOCKED_COUNTRIES', () => {
  it('includes US', () => {
    expect(BLOCKED_COUNTRIES.has('US')).toBe(true)
  })

  it('includes UK / GB', () => {
    expect(BLOCKED_COUNTRIES.has('GB')).toBe(true)
  })

  it('does not include DE (Germany is fine for Polymarket)', () => {
    expect(BLOCKED_COUNTRIES.has('DE')).toBe(false)
  })
})

describe('getGeoStatus', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    _resetGeoCache()
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('returns blocked when Worker says so', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'US', blocked: true }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await getGeoStatus('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
    expect(r.country).toBe('US')
    expect(r.unknown).toBe(false)
    expect(r.errorReason).toBeUndefined()
  })

  it('returns allowed when Worker says so (e.g. Serbia)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'RS', blocked: false }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await getGeoStatus('https://w.example', 'sec')
    expect(r.blocked).toBe(false)
    expect(r.country).toBe('RS')
    expect(r.unknown).toBe(false)
  })

  it('flags network error with reason "network"', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('net') }) as unknown as typeof fetch
    const r = await getGeoStatus('https://w.example', 'sec')
    expect(r.unknown).toBe(true)
    expect(r.errorReason).toBe('network')
  })

  it('flags 401 with reason "unauthorized" (origin or secret mismatch)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 401 }),
    ) as unknown as typeof fetch
    const r = await getGeoStatus('https://w.example', 'sec')
    expect(r.unknown).toBe(true)
    expect(r.errorReason).toBe('unauthorized')
  })

  it('flags 503 with reason "misconfigured"', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 503 }),
    ) as unknown as typeof fetch
    const r = await getGeoStatus('https://w.example', 'sec')
    expect(r.unknown).toBe(true)
    expect(r.errorReason).toBe('misconfigured')
  })

  it('flags missing Worker config as "no_worker"', async () => {
    const r = await getGeoStatus('', '')
    expect(r.unknown).toBe(true)
    expect(r.errorReason).toBe('no_worker')
  })

  it('caches result for the session', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'DE', blocked: false }), { status: 200 }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await getGeoStatus('https://w.example', 'sec')
    await getGeoStatus('https://w.example', 'sec')
    await getGeoStatus('https://w.example', 'sec')
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
  })
})
