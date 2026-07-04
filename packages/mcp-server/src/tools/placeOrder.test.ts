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

  it('rejects via the spend guard before ever calling signAndSubmit', async () => {
    let signAndSubmitCalled = false
    const result = await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => {
          signAndSubmitCalled = true
          return { success: true, orderId: 'x' }
        },
        spendGuard: { check: () => ({ ok: false, error: 'order_exceeds_max_usd:100' }), record: () => {} },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 500, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_exceeds_max_usd:100')
    expect(signAndSubmitCalled).toBe(false)
  })

  it('records spend only after a confirmed successful submit', async () => {
    let recordedUsd: number | undefined
    await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: { check: () => ({ ok: true }), record: (usd) => { recordedUsd = usd } },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 25, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(recordedUsd).toBe(25)
  })

  it('does not record spend when the submit fails', async () => {
    let recordCalled = false
    await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: false, error: 'insufficient_balance' }),
        spendGuard: { check: () => ({ ok: true }), record: () => { recordCalled = true } },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 25, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(recordCalled).toBe(false)
  })
})
