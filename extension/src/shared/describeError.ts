/**
 * Turn anything a catch block caught into a line a person can act on.
 *
 * `String(err)` is the obvious thing to write and it is wrong for exactly the
 * errors that matter most here: WalletConnect and the CLOB reject with plain
 * JSON-RPC objects, not Errors, and `String({code, message})` is the string
 * "[object Object]". Three of those in a row is what the extension's error
 * list showed for a failed wallet connect - a report that the thing failed,
 * with the reason carefully removed.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  if (typeof err !== 'object' || err === null) return String(err)

  const record = err as Record<string, unknown>
  const nested = record.error
  const source =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record

  const message = source.message ?? source.reason
  if (typeof message === 'string' && message.length > 0) {
    const code = source.code
    return code == null ? message : `${message} (code ${String(code)})`
  }

  try {
    return JSON.stringify(err)
  } catch {
    // Circular, or something else JSON refuses. Nothing better is available,
    // but at least the caller gets a string rather than a throw from the
    // error-reporting path itself.
    return Object.prototype.toString.call(err)
  }
}
