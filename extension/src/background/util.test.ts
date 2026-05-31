import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  b64ToFloatArray,
  cosineSimilarity,
  findOutcomeIndex,
  floatArrayToB64,
  formatRelative,
  safeJsonArray,
  sha256,
  shortHash,
  uuid,
} from './util'

describe('floatArrayToB64 / b64ToFloatArray', () => {
  it('round-trips a Float32Array', () => {
    const v = new Float32Array([0.1, -0.2, 0.3, 1e-7, -1.5])
    const b64 = floatArrayToB64(v)
    const back = b64ToFloatArray(b64)
    expect(back.length).toBe(v.length)
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 6)
  })

  it('handles empty arrays', () => {
    const b64 = floatArrayToB64(new Float32Array(0))
    expect(b64ToFloatArray(b64).length).toBe(0)
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6)
  })

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3])
    const b = new Float32Array([-1, -2, -3])
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6)
  })

  it('returns 0 for zero vector to avoid NaN', () => {
    const z = new Float32Array([0, 0, 0])
    const v = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(z, v)).toBe(0)
  })

  it('handles mismatched lengths via min length', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
  })
})

describe('sha256', () => {
  it('matches known SHA-256 of "hello"', async () => {
    const h = await sha256('hello')
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('returns stable hash for same input', async () => {
    const a = await sha256('the same string')
    const b = await sha256('the same string')
    expect(a).toBe(b)
  })
})

describe('findOutcomeIndex', () => {
  it('returns 0 when Yes is first', () => {
    expect(findOutcomeIndex('["Yes","No"]', 'Yes')).toBe(0)
    expect(findOutcomeIndex('["Yes","No"]', 'No')).toBe(1)
  })

  it('returns 1 when Yes is second — the trap case', () => {
    expect(findOutcomeIndex('["No","Yes"]', 'Yes')).toBe(1)
    expect(findOutcomeIndex('["No","Yes"]', 'No')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(findOutcomeIndex('["yes","no"]', 'Yes')).toBe(0)
    expect(findOutcomeIndex('["NO","YES"]', 'Yes')).toBe(1)
  })

  it('falls back to positional default on garbage input', () => {
    expect(findOutcomeIndex('not json', 'Yes')).toBe(0)
    expect(findOutcomeIndex('not json', 'No')).toBe(1)
    expect(findOutcomeIndex('["Maybe","Unsure"]', 'Yes')).toBe(0)
  })
})

describe('uuid', () => {
  it('returns RFC 4122 v4 shape', () => {
    const id = uuid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('returns distinct ids on repeat', () => {
    const a = uuid()
    const b = uuid()
    expect(a).not.toBe(b)
  })
})

describe('safeJsonArray', () => {
  it('parses a JSON-encoded string array', () => {
    expect(safeJsonArray('["Yes","No"]')).toEqual(['Yes', 'No'])
  })

  it('returns [] on malformed JSON', () => {
    expect(safeJsonArray('not json')).toEqual([])
  })

  it('returns [] on null / undefined', () => {
    expect(safeJsonArray(undefined)).toEqual([])
    expect(safeJsonArray('')).toEqual([])
  })

  it('coerces non-string elements to string', () => {
    // Gamma sometimes serializes numeric prices as numbers; we want consistent
    // string semantics so downstream parseFloat works either way.
    expect(safeJsonArray('[0.23, "0.77"]')).toEqual(['0.23', '0.77'])
  })

  it('returns [] when the parsed value is not an array', () => {
    expect(safeJsonArray('{"foo":1}')).toEqual([])
    expect(safeJsonArray('42')).toEqual([])
  })
})

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Fixed wall clock for deterministic relative math.
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" within the first minute', () => {
    expect(formatRelative(Date.now() - 10_000)).toBe('just now')
  })

  it('renders past minutes / hours / days', () => {
    expect(formatRelative(Date.now() - 5 * 60_000)).toBe('5m ago')
    expect(formatRelative(Date.now() - 2 * 60 * 60_000)).toBe('2h ago')
    expect(formatRelative(Date.now() - 3 * 86_400_000)).toBe('3d ago')
  })

  it('falls back to locale date past one week', () => {
    const past = Date.now() - 60 * 86_400_000
    expect(formatRelative(past)).toMatch(/\d/)
    expect(formatRelative(past)).not.toMatch(/ago$/)
  })

  it('renders future dates as today / tomorrow / in Nd', () => {
    expect(formatRelative(Date.now() + 5 * 60 * 60_000)).toBe('today')
    expect(formatRelative(Date.now() + 26 * 60 * 60_000)).toBe('tomorrow')
    expect(formatRelative(Date.now() + 5 * 86_400_000)).toBe('in 5d')
  })

  it('accepts Date instances as well as numbers', () => {
    const d = new Date(Date.now() - 3 * 60_000)
    expect(formatRelative(d)).toBe('3m ago')
  })
})

describe('shortHash', () => {
  it('is deterministic', () => {
    expect(shortHash('market-123')).toBe(shortHash('market-123'))
  })

  it('returns a fixed-width 8-char hex string', () => {
    expect(shortHash('a')).toMatch(/^[0-9a-f]{8}$/)
    expect(shortHash('').length).toBe(8)
    expect(shortHash('x'.repeat(1000)).length).toBe(8)
  })

  it('differs for different inputs (no obvious collisions in this set)', () => {
    const ids = ['mkt-1', 'mkt-2', 'mkt-3', 'mkt-4', 'mkt-5', 'will-x-by-y']
    const hashes = new Set(ids.map(shortHash))
    expect(hashes.size).toBe(ids.length)
  })

  it('handles unicode without throwing', () => {
    expect(() => shortHash('какой-то 🚀 id')).not.toThrow()
  })
})

describe('findOutcomeIndex — YES/NO token mapping', () => {
  // Regression coverage for the Sprint 2 bug: live price was being fetched
  // for clobTokenIds[0] regardless of outcome order, so markets with
  // outcomes=["No","Yes"] would display the NO probability under the YES
  // label. Each callsite now resolves the index by string label.

  it('returns 0 when outcomes start with Yes', () => {
    expect(findOutcomeIndex('["Yes","No"]', 'Yes')).toBe(0)
    expect(findOutcomeIndex('["Yes","No"]', 'No')).toBe(1)
  })

  it('returns 1 when outcomes start with No (this is the regression case)', () => {
    expect(findOutcomeIndex('["No","Yes"]', 'Yes')).toBe(1)
    expect(findOutcomeIndex('["No","Yes"]', 'No')).toBe(0)
  })

  it('parallels clobTokenIds correctly via the same index', () => {
    // The actual production callsite does:
    //   const yesIdx = findOutcomeIndex(market.outcomes, 'Yes')
    //   const tokenId = market.clobTokenIds[yesIdx]
    // Verify that contract on both outcome orderings.
    const reversed = { outcomes: '["No","Yes"]', clobTokenIds: ['TOK_NO', 'TOK_YES'] }
    const normal = { outcomes: '["Yes","No"]', clobTokenIds: ['TOK_YES', 'TOK_NO'] }
    expect(reversed.clobTokenIds[findOutcomeIndex(reversed.outcomes, 'Yes')]).toBe('TOK_YES')
    expect(normal.clobTokenIds[findOutcomeIndex(normal.outcomes, 'Yes')]).toBe('TOK_YES')
    expect(reversed.clobTokenIds[findOutcomeIndex(reversed.outcomes, 'No')]).toBe('TOK_NO')
    expect(normal.clobTokenIds[findOutcomeIndex(normal.outcomes, 'No')]).toBe('TOK_NO')
  })

  it('is case-insensitive against Gamma label casing drift', () => {
    expect(findOutcomeIndex('["YES","NO"]', 'Yes')).toBe(0)
    expect(findOutcomeIndex('["yes","no"]', 'No')).toBe(1)
  })

  it('defaults gracefully on malformed input', () => {
    expect(findOutcomeIndex('not json', 'Yes')).toBe(0)
    expect(findOutcomeIndex('not json', 'No')).toBe(1)
  })
})
