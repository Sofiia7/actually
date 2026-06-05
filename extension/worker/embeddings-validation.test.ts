import { describe, expect, it } from 'vitest'
import { EMBED_LIMITS, validateEmbeddingsInput } from './index'

describe('validateEmbeddingsInput', () => {
  it('accepts a well-formed body and reports total chars', () => {
    const r = validateEmbeddingsInput({ texts: ['hello', 'world'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.texts).toEqual(['hello', 'world'])
      expect(r.totalChars).toBe(10)
    }
  })

  it('carries through an optional model string', () => {
    const r = validateEmbeddingsInput({ texts: ['x'], model: 'text-embedding-3-small' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe('text-embedding-3-small')
  })

  it('rejects a non-object body', () => {
    expect(validateEmbeddingsInput(null)).toMatchObject({ ok: false, status: 400 })
    expect(validateEmbeddingsInput('nope')).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects when texts is missing or not an array', () => {
    expect(validateEmbeddingsInput({})).toMatchObject({ ok: false, status: 400 })
    expect(validateEmbeddingsInput({ texts: 'x' })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects an empty texts array', () => {
    expect(validateEmbeddingsInput({ texts: [] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects more than maxTexts entries', () => {
    const texts = Array.from({ length: EMBED_LIMITS.maxTexts + 1 }, () => 'a')
    expect(validateEmbeddingsInput({ texts })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a non-string element', () => {
    expect(validateEmbeddingsInput({ texts: ['ok', 123] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects a single text longer than maxCharsPerText', () => {
    const big = 'a'.repeat(EMBED_LIMITS.maxCharsPerText + 1)
    expect(validateEmbeddingsInput({ texts: [big] })).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects when total chars exceed maxTotalChars', () => {
    // Each text is at the per-text limit; enough of them to blow the total cap.
    const per = 'a'.repeat(EMBED_LIMITS.maxCharsPerText)
    const n = Math.floor(EMBED_LIMITS.maxTotalChars / EMBED_LIMITS.maxCharsPerText) + 1
    const texts = Array.from({ length: Math.min(n, EMBED_LIMITS.maxTexts) }, () => per)
    // Ensure we actually exceed the total cap within the maxTexts allowance.
    if (texts.length * EMBED_LIMITS.maxCharsPerText <= EMBED_LIMITS.maxTotalChars) {
      // Defensive: limits should be configured so this case is reachable.
      expect(EMBED_LIMITS.maxTexts * EMBED_LIMITS.maxCharsPerText).toBeGreaterThan(EMBED_LIMITS.maxTotalChars)
    }
    expect(validateEmbeddingsInput({ texts })).toMatchObject({ ok: false, status: 400 })
  })
})
