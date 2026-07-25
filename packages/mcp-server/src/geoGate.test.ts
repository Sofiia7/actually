import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTradingGeoGateCache, checkTradingGeoGate } from './geoGate'

describe('checkTradingGeoGate', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    _resetTradingGeoGateCache()
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('allows trading when the worker says the country is not blocked', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'DE', blocked: false }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(false)
    expect(r.country).toBe('DE')
  })

  it('blocks trading when the worker says the country is restricted', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'US', blocked: true }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
    expect(r.country).toBe('US')
  })

  it('fails closed on a network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('net')
    }) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
  })

  it('fails closed on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
  })

  it('fails closed when the response has no country', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
  })

  it('fails closed when the response has a country but no `blocked` field at all', async () => {
    // Regression: `Boolean(undefined) === false` would otherwise read a
    // missing field as "not blocked" — this must fail closed instead.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'DE' }), { status: 200 }),
    ) as unknown as typeof fetch
    const r = await checkTradingGeoGate('https://w.example', 'sec')
    expect(r.blocked).toBe(true)
  })

  it('caches the verdict within the TTL instead of re-fetching every call', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ country: 'DE', blocked: false }), { status: 200 }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await checkTradingGeoGate('https://w.example', 'sec')
    await checkTradingGeoGate('https://w.example', 'sec')
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
  })
})
