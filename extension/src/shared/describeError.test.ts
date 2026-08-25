import { describe, expect, it } from 'vitest'
import { describeError } from './describeError'

describe('describeError', () => {
  it('uses the message of a real Error', () => {
    expect(describeError(new Error('relay unreachable'))).toBe('relay unreachable')
  })

  it('passes a string through unchanged', () => {
    expect(describeError('wc_project_id_missing')).toBe('wc_project_id_missing')
  })

  // The reason diagnosis was stuck: WalletConnect rejects with a plain
  // JSON-RPC error object, and String() on that is "[object Object]", which is
  // what the extension's error list and the connect log were showing.
  it('reads a JSON-RPC rejection instead of stringifying it to [object Object]', () => {
    const rejection = { code: -32000, message: 'User rejected.' }
    expect(describeError(rejection)).toBe('User rejected. (code -32000)')
  })

  it('reaches into a nested error object', () => {
    expect(describeError({ error: { code: 5000, message: 'Session expired' } })).toBe(
      'Session expired (code 5000)',
    )
  })

  it('keeps a message that carries no code', () => {
    expect(describeError({ message: 'Proposal expired' })).toBe('Proposal expired')
  })

  it('falls back to JSON for an object with no message at all', () => {
    expect(describeError({ topic: 'abc', reason: 7 })).toBe('{"topic":"abc","reason":7}')
  })

  it('survives an object that cannot be serialized', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(describeError(circular)).toBe('[object Object]')
  })

  it('names an Error that carries no message', () => {
    expect(describeError(new TypeError())).toBe('TypeError')
  })

  it('describes nothing at all as nothing at all', () => {
    expect(describeError(undefined)).toBe('undefined')
    expect(describeError(null)).toBe('null')
  })
})
