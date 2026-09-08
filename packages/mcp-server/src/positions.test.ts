import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPositions } from './positions'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchPositions', () => {
  it('queries data-api directly with the user param and maps fields', async () => {
    const raw = [
      {
        asset: 'tok-yes',
        conditionId: 'cond-1',
        size: 40,
        avgPrice: 0.3,
        curPrice: 0.35,
        currentValue: 14,
        cashPnl: 2,
        percentPnl: 16.6,
        outcome: 'Yes',
        outcomeIndex: 0,
        negativeRisk: false,
        redeemable: true,
        title: 'Will X happen?',
        slug: 'will-x-happen',
      },
    ]
    const spy = vi.fn(async (_url: string) => new Response(JSON.stringify(raw), { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const positions = await fetchPositions('0xabc')
    expect(positions).toEqual([
      {
        tokenId: 'tok-yes',
        conditionId: 'cond-1',
        size: 40,
        avgPrice: 0.3,
        curPrice: 0.35,
        currentValue: 14,
        cashPnl: 2,
        percentPnl: 16.6,
        outcome: 'Yes',
        outcomeIndex: 0,
        negativeRisk: false,
        redeemable: true,
        title: 'Will X happen?',
        slug: 'will-x-happen',
      },
    ])
    const [url] = spy.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.origin + parsed.pathname).toBe('https://data-api.polymarket.com/positions')
    expect(parsed.searchParams.get('user')).toBe('0xabc')
  })

  it('defaults negativeRisk/redeemable when the API omits them, but marks outcomeIndex as UNKNOWN rather than assuming YES (2026-09-08 audit F09)', async () => {
    // A missing outcomeIndex must fail buildRedeemTransaction's
    // invalid_outcome_index check (core/redeem.ts, `!== 0 && !== 1`), not
    // silently redeem as slot 0 (YES) - a NO position with a missing index
    // would otherwise put the payout in the wrong neg-risk slot. Matches
    // the extension's own positions.ts, which already uses -1 for this.
    const raw = [{ asset: 'tok-yes', conditionId: 'cond-1', size: 40 }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 })))
    const [position] = await fetchPositions('0xabc')
    expect(position.outcomeIndex).toBe(-1)
    expect(position.negativeRisk).toBe(false)
    expect(position.redeemable).toBe(false)
  })

  it('requests sizeThreshold=0 so dust remainders under one share are not silently dropped (2026-09-08 audit F16)', async () => {
    const spy = vi.fn(async (_url: string) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await fetchPositions('0xabc')
    const [url] = spy.mock.calls[0]
    expect(new URL(String(url)).searchParams.get('sizeThreshold')).toBe('0')
  })

  it('pages through the full portfolio instead of stopping at the API\'s default 100-position page (2026-09-08 audit F16)', async () => {
    const spy = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0')
      const limit = Number(new URL(url).searchParams.get('limit'))
      // First page: a full page (forces a second request). Second page:
      // fewer than a full page (the real end of the portfolio).
      const count = offset === 0 ? limit : 3
      const page = Array.from({ length: count }, (_, i) => ({
        asset: `tok-${offset + i}`, conditionId: `cond-${offset + i}`, size: 0.4, outcomeIndex: 0,
      }))
      return new Response(JSON.stringify(page), { status: 200 })
    })
    vi.stubGlobal('fetch', spy)

    const positions = await fetchPositions('0xabc')

    expect(spy).toHaveBeenCalledTimes(2)
    const firstLimit = Number(new URL(String(spy.mock.calls[0][0])).searchParams.get('limit'))
    expect(positions).toHaveLength(firstLimit + 3)
    expect(new Set(positions.map((p) => p.tokenId)).size).toBe(positions.length) // no duplicate/overlapping page
  })

  it('stops after one request when the first page is already partial', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify([
      { asset: 'tok-1', conditionId: 'cond-1', size: 40, outcomeIndex: 0 },
    ]), { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const positions = await fetchPositions('0xabc')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(positions).toHaveLength(1)
  })

  it('returns an empty array when the address has no positions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    expect(await fetchPositions('0xabc')).toEqual([])
  })

  it('throws a typed error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(fetchPositions('0xabc')).rejects.toThrow('positions_fetch_failed:500')
  })
})
