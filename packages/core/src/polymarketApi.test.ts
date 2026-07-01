import { describe, expect, it } from 'vitest'
import { normalizeTick } from './polymarketApi'

describe('normalizeTick', () => {
  it('accepts the two CLOB-canonical tick sizes', () => {
    expect(normalizeTick('0.01')).toBe('0.01')
    expect(normalizeTick('0.001')).toBe('0.001')
  })

  it('accepts numeric input from Gamma', () => {
    expect(normalizeTick(0.01)).toBe('0.01')
    expect(normalizeTick(0.001)).toBe('0.001')
  })

  it('strips trailing zeros so the string round-trips cleanly', () => {
    expect(normalizeTick(0.1)).toBe('0.1')
    expect(normalizeTick('0.0100')).toBe('0.01')
  })

  it('rejects out-of-band values (caller falls back to negRisk default)', () => {
    expect(normalizeTick(0)).toBeUndefined()
    expect(normalizeTick(-0.01)).toBeUndefined()
    expect(normalizeTick(1)).toBeUndefined()
    expect(normalizeTick(2)).toBeUndefined()
    expect(normalizeTick(NaN)).toBeUndefined()
    expect(normalizeTick(Infinity)).toBeUndefined()
  })

  it('returns undefined for missing or unparseable input', () => {
    expect(normalizeTick(undefined)).toBeUndefined()
    expect(normalizeTick('')).toBeUndefined()
    expect(normalizeTick('not a number')).toBeUndefined()
  })
})
