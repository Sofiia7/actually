import { describe, expect, it } from 'vitest'
import { sellOrder } from './sellOrder'

const baseInput = {
  marketId: 'm1',
  tokenId: 'tok-yes',
  side: 'SELL_YES' as const,
  sizeShares: 40,
  price: 0.3,
  orderType: 'LIMIT' as const,
  negRisk: false,
}

describe('sellOrder', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await sellOrder(
      { privateKey: undefined, signAndSubmit: async () => ({ success: true, orderId: 'x' }) },
      baseInput,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('delegates to signAndSubmit and returns its orderId on success', async () => {
    const result = await sellOrder(
      { privateKey: '0xabc', signAndSubmit: async (args) => {
        expect(args.tokenId).toBe('tok-yes')
        expect(args.sizeShares).toBe(40)
        return { success: true, orderId: 'order-1' }
      } },
      baseInput,
    )
    expect(result.ok).toBe(true)
    expect(result.orderId).toBe('order-1')
  })

  it('surfaces a submission failure without throwing', async () => {
    const result = await sellOrder(
      { privateKey: '0xabc', signAndSubmit: async () => ({ success: false, error: 'insufficient_shares' }) },
      baseInput,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('insufficient_shares')
  })

  it('does not throw when signAndSubmit rejects', async () => {
    const result = await sellOrder(
      { privateKey: '0xabc', signAndSubmit: async () => { throw new Error('builder_code_not_configured') } },
      baseInput,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('applies the spend guard against the estimated notional (price * sizeShares)', async () => {
    let reservedUsd: number | undefined
    const result = await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: {
          reserve: (usd) => {
            reservedUsd = usd
            return { ok: false, error: 'order_exceeds_max_usd:10' }
          },
          release: () => {},
        },
      },
      baseInput,
    )
    expect(reservedUsd).toBeCloseTo(12, 6) // 40 shares * 0.3
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_exceeds_max_usd:10')
  })

  it('floors the guard estimate at marketPriceHint when the caller quotes a lowball price', async () => {
    let reservedUsd: number | undefined
    const result = await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: {
          reserve: (usd) => {
            reservedUsd = usd
            return { ok: false, error: 'daily_limit_exceeded:500' }
          },
          release: () => {},
        },
      },
      { ...baseInput, sizeShares: 10000, price: 0.01, marketPriceHint: 0.5 },
    )
    // Without the fix this would reserve 10000 * 0.01 = $100 while actually
    // liquidating ~$5000 of position at the real market price.
    expect(reservedUsd).toBeCloseTo(5000, 6)
    expect(result.ok).toBe(false)
  })

  it('does not lower the guard estimate when marketPriceHint is below the caller price', async () => {
    let reservedUsd: number | undefined
    await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: { reserve: (usd) => { reservedUsd = usd; return { ok: true } }, release: () => {} },
      },
      { ...baseInput, sizeShares: 40, price: 0.3, marketPriceHint: 0.1 },
    )
    expect(reservedUsd).toBeCloseTo(12, 6) // 40 * 0.3, the caller's (higher) price
  })

  it('releases the reserved spend when the submit fails', async () => {
    let releasedUsd: number | undefined
    await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: false, error: 'insufficient_shares' }),
        spendGuard: { reserve: () => ({ ok: true }), release: (usd) => { releasedUsd = usd } },
      },
      baseInput,
    )
    expect(releasedUsd).toBeCloseTo(12, 6)
  })
})

describe('sellOrder - minimum order size', () => {
  it('rejects a sub-minimum share count before signing', async () => {
    let signed = false
    const result = await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => {
          signed = true
          return { success: true, orderId: 'x' }
        },
      },
      {
        marketId: 'm1',
        tokenId: 'tok-yes',
        side: 'SELL_YES',
        sizeShares: 3,
        price: 0.5,
        orderType: 'LIMIT',
        negRisk: false,
      },
    )
    expect(result).toEqual({ ok: false, error: 'order_below_min_size:5' })
    expect(signed).toBe(false)
  })

  it('allows a sell at exactly the minimum', async () => {
    const result = await sellOrder(
      { privateKey: '0xabc', signAndSubmit: async () => ({ success: true, orderId: 'ok' }) },
      {
        marketId: 'm1',
        tokenId: 'tok-yes',
        side: 'SELL_YES',
        sizeShares: 5,
        price: 0.5,
        orderType: 'LIMIT',
        negRisk: false,
      },
    )
    expect(result).toEqual({ ok: true, orderId: 'ok' })
  })
})
