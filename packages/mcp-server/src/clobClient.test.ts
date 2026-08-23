import { describe, expect, it } from 'vitest'
import { cancelOrder } from './clobClient'
import type { ClobClient } from '@polymarket/clob-client-v2'

function fakeClient(cancelOrderImpl: (payload: { orderID: string }) => Promise<unknown>): ClobClient {
  return { cancelOrder: cancelOrderImpl } as unknown as ClobClient
}

describe('cancelOrder', () => {
  it('reports success when the orderId is in the canceled array', async () => {
    const client = fakeClient(async () => ({ canceled: ['o1'], not_canceled: {} }))
    const result = await cancelOrder(client, 'o1')
    expect(result).toEqual({ success: true })
  })

  it('reports failure when the orderId is in not_canceled with a reason', async () => {
    const client = fakeClient(async () => ({ canceled: [], not_canceled: { o1: 'order not found' } }))
    const result = await cancelOrder(client, 'o1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('order not found')
  })

  it('reports failure on an HTTP/axios error response (no success field at all)', async () => {
    // This is the shape clob-client-v2's errorHandling() returns for a non-2xx
    // response when throwOnError is off - no `success` field, which the old
    // `res.success === false` check could never match.
    const client = fakeClient(async () => ({ error: 'expired credentials', status: 401 }))
    const result = await cancelOrder(client, 'o1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('expired credentials')
  })

  it('does not report success for an ambiguous/unrecognized response shape', async () => {
    const client = fakeClient(async () => ({}))
    const result = await cancelOrder(client, 'o1')
    expect(result.success).toBe(false)
    expect(result.error).toBe('cancel_unconfirmed')
  })

  it('reports failure when the SDK call throws', async () => {
    const client = fakeClient(async () => {
      throw new Error('network_error')
    })
    const result = await cancelOrder(client, 'o1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('network_error')
  })
})
