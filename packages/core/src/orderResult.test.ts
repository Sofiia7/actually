import { describe, expect, it } from 'vitest'
import { classifyOrderPost } from './orderResult'

// What clob-client-v2's postOrder resolves to (it resolves, not throws, when
// throwOnError is off - which is how both the extension and the MCP server
// build their clients). The question each case answers: did the exchange say
// no, or do we simply not know?
describe('classifyOrderPost', () => {
  it('accepts a success with its order id', () => {
    expect(classifyOrderPost({ success: true, orderID: '0xabc' })).toEqual({ kind: 'accepted', orderId: '0xabc' })
  })

  it('reads a 200 with success:false as a rejection, with the reason', () => {
    expect(classifyOrderPost({ success: false, errorMsg: 'order is expired' })).toEqual({
      kind: 'rejected',
      error: 'order is expired',
    })
  })

  it('reads an HTTP 4xx as a rejection: the exchange answered, and it said no', () => {
    expect(classifyOrderPost({ error: 'invalid order minimum size', status: 400 })).toEqual({
      kind: 'rejected',
      error: 'invalid order minimum size',
    })
    expect(classifyOrderPost({ error: { code: 'INVALID_ORDER_MIN_SIZE' }, status: 400 })).toEqual({
      kind: 'rejected',
      error: '{"code":"INVALID_ORDER_MIN_SIZE"}',
    })
  })

  it('reads a lost response as unknown: the SDK resolves it to { error } with no HTTP status at all', () => {
    expect(classifyOrderPost({ error: 'Network Error' })).toEqual({ kind: 'unknown', error: 'Network Error' })
    expect(classifyOrderPost({ error: 'timeout of 10000ms exceeded' })).toEqual({
      kind: 'unknown',
      error: 'timeout of 10000ms exceeded',
    })
  })

  it('reads a 5xx as unknown: the order may already be on the book behind a failing gateway', () => {
    expect(classifyOrderPost({ error: 'Bad Gateway', status: 502 })).toEqual({ kind: 'unknown', error: 'Bad Gateway' })
    expect(classifyOrderPost({ status: 503 })).toEqual({ kind: 'unknown', error: 'clob_http_503' })
  })

  it('reads a "duplicate" answer as unknown: the SDK retries once by itself, so the first attempt may have landed', () => {
    expect(classifyOrderPost({ error: 'order is invalid. Duplicated.', status: 400 })).toEqual({
      kind: 'unknown',
      error: 'order is invalid. Duplicated.',
    })
    expect(classifyOrderPost({ success: false, errorMsg: 'duplicate order' })).toEqual({
      kind: 'unknown',
      error: 'duplicate order',
    })
  })

  it('reads an empty or unrecognisable response as unknown', () => {
    expect(classifyOrderPost(undefined)).toEqual({ kind: 'unknown', error: 'empty_response' })
    expect(classifyOrderPost(null)).toEqual({ kind: 'unknown', error: 'empty_response' })
    expect(classifyOrderPost('garbage')).toEqual({ kind: 'unknown', error: 'unexpected_response' })
  })

  it('falls back to clob_rejected only for a definite answer that carries no reason', () => {
    expect(classifyOrderPost({ success: false })).toEqual({ kind: 'rejected', error: 'clob_rejected' })
  })

  it('prefers the HTTP status to an empty structured error, which would read as "{}"', () => {
    expect(classifyOrderPost({ error: {}, status: 400 })).toEqual({ kind: 'rejected', error: 'clob_http_400' })
    expect(classifyOrderPost({ error: [], status: 403 })).toEqual({ kind: 'rejected', error: 'clob_http_403' })
  })
})
