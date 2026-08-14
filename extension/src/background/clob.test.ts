import { describe, expect, it, vi } from 'vitest'
import { cancelOrder, deriveCredentials, submitSignedOrder } from './clob'
import type { ClobClient } from '@polymarket/clob-client-v2'

const creds = { key: 'k', secret: 's', passphrase: 'p' }

describe('deriveCredentials — one wallet prompt, not two', () => {
  it('derives first and never calls create when the address already has a key', async () => {
    // Every one of these SDK calls builds L1 auth headers, and that costs one
    // eth_signTypedData_v4 — a wallet prompt the user must approve. The SDK's
    // createOrDeriveApiKey POSTs create first, which fails for any address
    // that already has a CLOB key (i.e. every returning user) and only then
    // derives: two prompts for one credential, on every single connect.
    const deriveApiKey = vi.fn(async () => creds)
    const createApiKey = vi.fn(async () => creds)
    const createOrDeriveApiKey = vi.fn(async () => creds)
    const client = { deriveApiKey, createApiKey, createOrDeriveApiKey } as unknown as ClobClient

    expect(await deriveCredentials(client)).toEqual(creds)
    expect(deriveApiKey).toHaveBeenCalledTimes(1)
    expect(createApiKey).not.toHaveBeenCalled()
    expect(createOrDeriveApiKey).not.toHaveBeenCalled()
  })

  it('falls back to create for a brand-new key, when derive has nothing to derive', async () => {
    // A non-2xx resolves to an error object rather than throwing (we don't
    // set the SDK's throwOnError), so "returned something" ≠ "returned
    // credentials".
    const deriveApiKey = vi.fn(async () => ({ error: 'no api key exists' }) as never)
    const createApiKey = vi.fn(async () => creds)
    const client = { deriveApiKey, createApiKey } as unknown as ClobClient

    expect(await deriveCredentials(client)).toEqual(creds)
    expect(deriveApiKey).toHaveBeenCalledTimes(1)
    expect(createApiKey).toHaveBeenCalledTimes(1)
  })

  it('falls back when derive throws outright', async () => {
    const client = {
      deriveApiKey: vi.fn(async () => {
        throw new Error('derive_boom')
      }),
      createApiKey: vi.fn(async () => creds),
    } as unknown as ClobClient
    expect(await deriveCredentials(client)).toEqual(creds)
  })

  it('reports every attempt when none of them yield credentials', async () => {
    const client = {
      deriveApiKey: vi.fn(async () => ({}) as never),
      createApiKey: vi.fn(async () => {
        throw new Error('create_boom')
      }),
    } as unknown as ClobClient
    await expect(deriveCredentials(client)).rejects.toThrow(/deriveApiKey:empty_credentials/)
    await expect(deriveCredentials(client)).rejects.toThrow(/createApiKey:create_boom/)
  })

  it('never falls through to the combined helper on top of the individual calls', async () => {
    // createOrDeriveApiKey internally does create-then-derive. Appending it
    // after derive and create have already been tried repeats both — and each
    // call is another wallet prompt, so a failing connect could ask the user
    // to sign four times.
    const deriveApiKey = vi.fn(async () => ({}) as never)
    const createApiKey = vi.fn(async () => ({}) as never)
    const createOrDeriveApiKey = vi.fn(async () => creds)
    const client = { deriveApiKey, createApiKey, createOrDeriveApiKey } as unknown as ClobClient

    await expect(deriveCredentials(client)).rejects.toThrow(/clob_api_key_failed/)
    expect(deriveApiKey).toHaveBeenCalledTimes(1)
    expect(createApiKey).toHaveBeenCalledTimes(1)
    expect(createOrDeriveApiKey).not.toHaveBeenCalled()
  })

  it('still works against an SDK exposing only the combined helper', async () => {
    const createOrDeriveApiKey = vi.fn(async () => creds)
    const client = { createOrDeriveApiKey } as unknown as ClobClient
    expect(await deriveCredentials(client)).toEqual(creds)
    expect(createOrDeriveApiKey).toHaveBeenCalledTimes(1)
  })

  it('throws a recognisable error when the SDK exposes no key method at all', async () => {
    await expect(deriveCredentials({} as unknown as ClobClient)).rejects.toThrow(
      'clob_sdk_missing_api_key_method',
    )
  })
})

function fakeClient(cancelOrderImpl: (payload: { orderID: string }) => Promise<unknown>): ClobClient {
  return { cancelOrder: cancelOrderImpl } as unknown as ClobClient
}

function fakePostClient(postOrderImpl: () => Promise<unknown>): ClobClient {
  return { postOrder: postOrderImpl } as unknown as ClobClient
}

describe('submitSignedOrder', () => {
  it('reports success and the order id', async () => {
    const client = fakePostClient(async () => ({ success: true, orderID: '0xabc' }))
    expect(await submitSignedOrder(client, {})).toEqual({ success: true, orderId: '0xabc' })
  })

  it('surfaces errorMsg from a 200-with-success:false rejection', async () => {
    const client = fakePostClient(async () => ({ success: false, errorMsg: 'order is expired' }))
    const r = await submitSignedOrder(client, {})
    expect(r).toEqual({ success: false, error: 'order is expired' })
  })

  it('surfaces the reason from an HTTP-error response instead of a bare clob_rejected', async () => {
    // The shape clob-client-v2's errorHandling() returns for a non-2xx POST
    // when throwOnError is off: no `success`, no `errorMsg` — only `error` +
    // `status`. Reading just `errorMsg` here is what turned every real CLOB
    // rejection ("below minimum size", "not enough balance") into an
    // undiagnosable "Failed: clob_rejected".
    const client = fakePostClient(async () => ({ error: 'invalid order minimum size', status: 400 }))
    const r = await submitSignedOrder(client, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('invalid order minimum size')
  })

  it('stringifies a structured error body', async () => {
    const client = fakePostClient(async () => ({ error: { code: 'INVALID_ORDER_MIN_SIZE' }, status: 400 }))
    const r = await submitSignedOrder(client, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('INVALID_ORDER_MIN_SIZE')
  })

  it('falls back to clob_rejected only when the response carries no reason at all', async () => {
    const client = fakePostClient(async () => ({ success: false }))
    expect(await submitSignedOrder(client, {})).toEqual({ success: false, error: 'clob_rejected' })
  })

  it('reports failure when the SDK call throws', async () => {
    const client = fakePostClient(async () => {
      throw new Error('network_error')
    })
    const r = await submitSignedOrder(client, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('network_error')
  })
})

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
    // response when throwOnError is off — no `success` field, which the old
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
