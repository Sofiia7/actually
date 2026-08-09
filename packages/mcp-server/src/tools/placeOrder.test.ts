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
        spendGuard: { reserve: () => ({ ok: false, error: 'order_exceeds_max_usd:100' }), release: () => {} },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 500, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_exceeds_max_usd:100')
    expect(signAndSubmitCalled).toBe(false)
  })

  it('reserves spend before submit and does not release it on a confirmed successful submit', async () => {
    let reservedUsd: number | undefined
    let releaseCalled = false
    await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: {
          reserve: (usd) => { reservedUsd = usd; return { ok: true } },
          release: () => { releaseCalled = true },
        },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 25, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(reservedUsd).toBe(25)
    expect(releaseCalled).toBe(false)
  })

  it('releases the reserved spend when the submit fails', async () => {
    let releasedUsd: number | undefined
    await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: false, error: 'insufficient_balance' }),
        spendGuard: { reserve: () => ({ ok: true }), release: (usd) => { releasedUsd = usd } },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 25, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(releasedUsd).toBe(25)
  })

  it('releases the reserved spend when signAndSubmit throws', async () => {
    let releasedUsd: number | undefined
    await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => { throw new Error('builder_code_not_configured') },
        spendGuard: { reserve: () => ({ ok: true }), release: (usd) => { releasedUsd = usd } },
      },
      { marketId: 'm1', tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 25, price: 0.5, orderType: 'MARKET', negRisk: false },
    )
    expect(releasedUsd).toBe(25)
  })
})

describe('placeOrder — minimum order size', () => {
  const base = {
    marketId: 'm1',
    tokenId: 'tok-yes',
    side: 'BUY_YES' as const,
    orderType: 'LIMIT' as const,
    negRisk: false,
  }

  it('rejects a below-minimum order without signing or reserving budget', async () => {
    let signed = false
    let reserved = false
    const result = await placeOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => {
          signed = true
          return { success: true, orderId: 'x' }
        },
        spendGuard: {
          reserve: () => {
            reserved = true
            return { ok: true as const }
          },
          release: () => {},
        },
      },
      // $1 at 31¢ buys 3.22 shares — under CLOB's 5-share floor.
      { ...base, sizeUsd: 1, price: 0.31 },
    )
    expect(result).toEqual({ ok: false, error: 'order_below_min_size:5' })
    expect(signed).toBe(false)
    expect(reserved).toBe(false)
  })

  it('allows the same dollar amount at a price where it clears the floor', async () => {
    const result = await placeOrder(
      { privateKey: '0xabc', signAndSubmit: async () => ({ success: true, orderId: 'ok' }) },
      { ...base, sizeUsd: 1, price: 0.15 }, // 6.66 shares
    )
    expect(result).toEqual({ ok: true, orderId: 'ok' })
  })

  it('honours a per-market minimum from the resolved market', async () => {
    const result = await placeOrder(
      { privateKey: '0xabc', signAndSubmit: async () => ({ success: true, orderId: 'ok' }) },
      { ...base, sizeUsd: 5, price: 0.5, minOrderSize: 20 }, // 10 shares < 20
    )
    expect(result).toEqual({ ok: false, error: 'order_below_min_size:20' })
  })
})
