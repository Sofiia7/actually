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
    expect(String(url)).toBe('https://data-api.polymarket.com/positions?user=0xabc')
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

  it('returns an empty array when the address has no positions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    expect(await fetchPositions('0xabc')).toEqual([])
  })

  it('throws a typed error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(fetchPositions('0xabc')).rejects.toThrow('positions_fetch_failed:500')
  })
})
