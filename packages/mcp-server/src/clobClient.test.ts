import { describe, expect, it } from 'vitest'
import { cancelOrder, submitSignedOrder } from './clobClient'
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

function fakeOrderClient(postOrderImpl: () => Promise<unknown>): ClobClient {
  return { postOrder: postOrderImpl } as unknown as ClobClient
}

describe('submitSignedOrder', () => {
  it('reports a confirmed CLOB rejection as safe to release reserved budget for', async () => {
    const client = fakeOrderClient(async () => ({ success: false, errorMsg: 'insufficient balance' }))
    const result = await submitSignedOrder(client, {})
    expect(result).toEqual({ success: false, error: 'insufficient balance' })
    expect(result.unknown).toBeUndefined()
  })

  it('reports success with the orderId on a confirmed fill', async () => {
    const client = fakeOrderClient(async () => ({ success: true, orderID: 'order-1' }))
    const result = await submitSignedOrder(client, {})
    expect(result).toEqual({ success: true, orderId: 'order-1' })
  })

  it('marks a thrown transport error as unknown rather than a confirmed rejection (2026-09-08 audit F03)', async () => {
    // The exchange may have already accepted the order upstream even though
    // this process never saw a response - a caller must not treat this the
    // same as a confirmed "no" and release the spend-guard reservation.
    const client = fakeOrderClient(async () => {
      throw new Error('ECONNRESET')
    })
    const result = await submitSignedOrder(client, {})
    expect(result.success).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.error).toContain('ECONNRESET')
  })

  it('marks an empty/undefined response as unknown rather than a confirmed rejection', async () => {
    const client = fakeOrderClient(async () => undefined)
    const result = await submitSignedOrder(client, {})
    expect(result).toEqual({ success: false, error: 'empty_response', unknown: true })
  })

  // The case the F03 fix above missed: the SDK does not throw on a lost
  // response, it RESOLVES { error } with no HTTP status - which read as a
  // confirmed rejection and released the reservation of an order that may
  // be on the book.
  it('marks a lost response the SDK resolves as { error } with no status as unknown', async () => {
    const client = fakeOrderClient(async () => ({ error: 'timeout of 10000ms exceeded' }))
    const result = await submitSignedOrder(client, {})
    expect(result).toEqual({ success: false, error: 'timeout of 10000ms exceeded', unknown: true })
  })

  it('marks a 5xx as unknown', async () => {
    const client = fakeOrderClient(async () => ({ error: 'Bad Gateway', status: 502 }))
    expect((await submitSignedOrder(client, {})).unknown).toBe(true)
  })

  it('marks a "duplicate" answer as unknown: the SDK retried once, so the first attempt may have landed', async () => {
    const client = fakeOrderClient(async () => ({ error: 'order is invalid. Duplicated.', status: 400 }))
    expect((await submitSignedOrder(client, {})).unknown).toBe(true)
  })

  it('keeps a 4xx a confirmed rejection, with the CLOB reason', async () => {
    const client = fakeOrderClient(async () => ({ error: 'invalid order minimum size', status: 400 }))
    expect(await submitSignedOrder(client, {})).toEqual({ success: false, error: 'invalid order minimum size' })
  })
})
