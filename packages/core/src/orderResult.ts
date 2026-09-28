/**
 * Reading what the CLOB said to a posted order.
 *
 * clob-client-v2's postOrder RESOLVES, rather than throws, on every failure
 * when throwOnError is off (how both the extension and the MCP server build
 * their clients), and the shapes it resolves to do not mean the same thing:
 *
 * - `{ success: true, orderID }` - accepted.
 * - `{ success: false, errorMsg }` (HTTP 200) or `{ error, status: 4xx }` -
 *   the exchange answered and said no. Nothing was placed; retrying is safe.
 * - `{ error }` with NO status - the request never got an HTTP answer
 *   (timeout, dropped connection). The order may well have reached the
 *   exchange and been accepted there.
 * - `{ error, status: 5xx }` - a gateway or server failure, same ambiguity.
 *
 * The SDK also retries a transient failure once by itself before answering,
 * so a "duplicate" rejection means an earlier attempt of this very order got
 * through. Treating any of the ambiguous ones as a plain rejection is what let
 * a user (or an agent) retry an order that had in fact been placed
 * (2026-09-08 audit F03).
 */

export type OrderPostOutcome =
  | { kind: 'accepted'; orderId?: string }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string }

interface PostOrderResponse {
  success?: boolean
  errorMsg?: string
  orderID?: string
  error?: unknown
  // A string on the success shape (e.g. "matched"), the numeric HTTP status
  // on the SDK's error shape.
  status?: number | string
}

/**
 * A human-meaningful reason from either CLOB failure shape, or null when the
 * response genuinely carries none.
 */
export function orderErrorText(res: PostOrderResponse): string | null {
  if (typeof res.errorMsg === 'string' && res.errorMsg.trim() !== '') return res.errorMsg
  if (typeof res.error === 'string' && res.error.trim() !== '') return res.error
  // Only a structured error that stringifies to something readable - an
  // empty {} or [] says less than the status fallback below.
  if (res.error !== undefined && res.error !== null && typeof res.error !== 'string') {
    const s = JSON.stringify(res.error)
    if (s && s !== '{}' && s !== '[]') return s
  }
  if (typeof res.status === 'number') return `clob_http_${res.status}`
  if (typeof res.status === 'string' && res.status.trim() !== '') return `clob_status_${res.status}`
  return null
}

export function classifyOrderPost(res: unknown): OrderPostOutcome {
  if (res === undefined || res === null) return { kind: 'unknown', error: 'empty_response' }
  if (typeof res !== 'object') return { kind: 'unknown', error: 'unexpected_response' }
  const r = res as PostOrderResponse
  if (r.success === true) return { kind: 'accepted', orderId: r.orderID }
  const error = orderErrorText(r) ?? 'clob_rejected'
  if (/duplicat/i.test(error)) return { kind: 'unknown', error }
  if (typeof r.status === 'number') {
    return r.status >= 500 ? { kind: 'unknown', error } : { kind: 'rejected', error }
  }
  // An `error` with no HTTP status is the SDK's shape for a request that got
  // no answer at all. `success: false` without it is an answer.
  if (r.error !== undefined && r.success === undefined) return { kind: 'unknown', error }
  return { kind: 'rejected', error }
}
