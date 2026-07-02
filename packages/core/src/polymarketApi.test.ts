import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTick } from './polymarketApi'
import { fetchOrderbookJson } from './polymarketApi'

describe('normalizeTick', () => {
  it('accepts the two CLOB-canonical tick sizes', () => {
    expect(normalizeTick('0.01')).toBe('0.01')
    expect(normalizeTick('0.001')).toBe('0.001')
  })

  it('accepts numeric input from Gamma', () => {
    expect(normalizeTick(0.01)).toBe('0.01')
    expect(normalizeTick(0.001)).toBe('0.001')
  })

  it('strips trailing zeros so the string round-trips cleanly', () => {
    expect(normalizeTick(0.1)).toBe('0.1')
    expect(normalizeTick('0.0100')).toBe('0.01')
  })

  it('rejects out-of-band values (caller falls back to negRisk default)', () => {
    expect(normalizeTick(0)).toBeUndefined()
    expect(normalizeTick(-0.01)).toBeUndefined()
    expect(normalizeTick(1)).toBeUndefined()
    expect(normalizeTick(2)).toBeUndefined()
    expect(normalizeTick(NaN)).toBeUndefined()
    expect(normalizeTick(Infinity)).toBeUndefined()
  })

  it('returns undefined for missing or unparseable input', () => {
    expect(normalizeTick(undefined)).toBeUndefined()
    expect(normalizeTick('')).toBeUndefined()
    expect(normalizeTick('not a number')).toBeUndefined()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOrderbookJson', () => {
  it('fetches the worker /orderbook proxy with the token id and auth header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ asks: [], bids: [] }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const book = await fetchOrderbookJson('tok-1', 'https://worker.example', 'secret')
    expect(book).toEqual({ asks: [], bids: [] })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/orderbook?token_id=tok-1')
    expect((init.headers as Record<string, string>)['X-Actually-Auth']).toBe('secret')
  })

  it('returns an empty book on a non-ok response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const book = await fetchOrderbookJson('tok-1', 'https://worker.example', 'secret')
    expect(book).toEqual({ asks: [], bids: [] })
  })
})
