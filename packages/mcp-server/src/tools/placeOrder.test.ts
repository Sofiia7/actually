import { describe, expect, it } from 'vitest'
import { placeOrder } from './placeOrder'

describe('placeOrder', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await placeOrder(
      { privateKey: undefined, signAndSubmit: async () => ({ success: true, orderId: 'x' }) },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 10, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('delegates to signAndSubmit and returns its orderId on success', async () => {
    const result = await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async (args) => {
          expect(args.tokenId).toBe('tok-yes')
          expect(args.sizeUsd).toBe(10)
          return { success: true, orderId: 'order-123' }
        },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 10, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(true)
    expect(result.orderId).toBe('order-123')
  })

  it('surfaces a submission failure without throwing', async () => {
    const result = await placeOrder(
      { privateKey: '0xabc', signAndSubmit: async () => ({ success: false, error: 'insufficient_balance' }) },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 10, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('insufficient_balance')
  })

  it('does not throw when signAndSubmit rejects', async () => {
    const result = await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => {
          throw new Error('builder_code_not_configured')
        },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 10, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
