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
        title: 'Will X happen?',
        slug: 'will-x-happen',
      },
    ])
    const [url] = spy.mock.calls[0]
    expect(String(url)).toBe('https://data-api.polymarket.com/positions?user=0xabc')
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
