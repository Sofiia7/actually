import { describe, expect, it } from 'vitest'
import { b64ToFloatArray, cosineSimilarity, floatArrayToB64, sha256, uuid } from './util'

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
