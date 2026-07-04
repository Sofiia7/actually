import { describe, expect, it } from 'vitest'
import { getOpenOrders } from './getOpenOrders'

const fakeOrder = {
  orderId: 'o1',
  marketId: 'm1',
  tokenId: 'tok-yes',
  side: 'BUY',
  price: '0.3',
  originalSize: '10',
  sizeMatched: '0',
  status: 'LIVE',
}

describe('getOpenOrders', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await getOpenOrders(
      { privateKey: undefined, listOpenOrders: async () => [fakeOrder] },
      {},
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('lists open orders, forwarding an optional marketId filter', async () => {
    let filterUsed: string | undefined
    const result = await getOpenOrders(
      {
        privateKey: '0xkey',
        listOpenOrders: async (marketId) => {
          filterUsed = marketId
          return [fakeOrder]
        },
      },
      { marketId: 'm1' },
    )
    expect(filterUsed).toBe('m1')
    expect(result.ok).toBe(true)
    expect(result.orders).toEqual([fakeOrder])
  })

  it('surfaces a listing failure without throwing', async () => {
    const result = await getOpenOrders(
      {
        privateKey: '0xkey',
        listOpenOrders: async () => {
          throw new Error('clob_unreachable')
        },
      },
      {},
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('clob_unreachable')
  })
})
