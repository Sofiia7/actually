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
    let checkedUsd: number | undefined
    const result = await sellOrder(
      {
        privateKey: '0xabc',
        signAndSubmit: async () => ({ success: true, orderId: 'x' }),
        spendGuard: {
          check: (usd) => {
            checkedUsd = usd
            return { ok: false, error: 'order_exceeds_max_usd:10' }
          },
          record: () => {},
        },
      },
      baseInput,
    )
    expect(checkedUsd).toBeCloseTo(12, 6) // 40 shares * 0.3
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_exceeds_max_usd:10')
  })
})
