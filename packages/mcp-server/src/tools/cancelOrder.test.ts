import { describe, expect, it } from 'vitest'
import { cancelOrder } from './cancelOrder'

describe('cancelOrder', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await cancelOrder(
      { privateKey: undefined, cancelOrder: async () => ({ success: true }) },
      { orderId: 'o1' },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('cancels the given order id', async () => {
    let cancelledId: string | undefined
    const result = await cancelOrder(
      {
        privateKey: '0xkey',
        cancelOrder: async (orderId) => {
          cancelledId = orderId
          return { success: true }
        },
      },
      { orderId: 'o1' },
    )
    expect(cancelledId).toBe('o1')
    expect(result.ok).toBe(true)
  })

  it('surfaces a rejected cancel without throwing', async () => {
    const result = await cancelOrder(
      { privateKey: '0xkey', cancelOrder: async () => ({ success: false, error: 'order_not_found' }) },
      { orderId: 'o1' },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_not_found')
  })

  it('does not throw when the underlying cancel call rejects', async () => {
    const result = await cancelOrder(
      {
        privateKey: '0xkey',
        cancelOrder: async () => {
          throw new Error('network_error')
        },
      },
      { orderId: 'o1' },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('network_error')
  })
})
