import { describe, expect, it } from 'vitest'
import { prepareOrder } from './prepareOrder'

describe('prepareOrder', () => {
  it('returns not_configured when no builder code is baked into this build', () => {
    const result = prepareOrder(
      { builderCode: '' },
      { tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 20, price: 0.4, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('builds an unsigned MARKET order carrying the baked builderCode', () => {
    const result = prepareOrder(
      { builderCode: '0xbuilder' },
      { tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 20, price: 0.4, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(true)
    expect(result.unsignedOrder).toMatchObject({
      tokenID: 'tok-yes',
      amount: 20,
      side: 'BUY',
      orderType: 'FOK',
      builderCode: '0xbuilder',
      price: 0.4,
    })
    expect(result.warning).toMatch(/sign this exact object unchanged/i)
  })

  it('builds an unsigned LIMIT order with size converted from USD notional', () => {
    const result = prepareOrder(
      { builderCode: '0xbuilder' },
      { tokenId: 'tok-no', side: 'BUY_NO', sizeUsd: 20, price: 0.5, orderType: 'LIMIT', negRisk: true, tickSize: '0.001' },
    )
    expect(result.ok).toBe(true)
    expect(result.unsignedOrder).toMatchObject({
      tokenID: 'tok-no',
      price: 0.5,
      size: 40, // 20 / 0.5
      side: 'BUY',
      builderCode: '0xbuilder',
    })
  })
})
