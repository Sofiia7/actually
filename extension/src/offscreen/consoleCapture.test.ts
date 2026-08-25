import { describe, expect, it } from 'vitest'
import { formatConsoleArgs } from './consoleCapture'

describe('formatConsoleArgs', () => {
  it('leaves plain strings alone', () => {
    expect(formatConsoleArgs(['relay connected', 'topic abc'])).toBe('relay connected topic abc')
  })

  // WalletConnect's own logger writes objects straight to console.error, and
  // Chrome's extension error list renders those as "[object Object]". Three of
  // those in a row is what a failed wallet connect reported.
  it('expands the objects that WalletConnect logs instead of [object Object]', () => {
    const out = formatConsoleArgs([{ context: 'core/relayer' }, { code: -32000, message: 'expired' }])
    expect(out).toContain('core/relayer')
    expect(out).toContain('expired')
    expect(out).not.toContain('[object Object]')
  })

  it('keeps an Error readable, message first', () => {
    expect(formatConsoleArgs([new Error('no matching key')])).toContain('no matching key')
  })

  it('survives an object that cannot be serialized', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => formatConsoleArgs([circular])).not.toThrow()
  })

  it('caps a huge payload so one log line cannot fill the buffer', () => {
    const big = { blob: 'x'.repeat(5000) }
    expect(formatConsoleArgs([big]).length).toBeLessThanOrEqual(600)
  })
})
