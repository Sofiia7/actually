import { describe, expect, it } from 'vitest'
import { deriveSafeAddress } from './safe'

describe('deriveSafeAddress', () => {
  it('derives a deterministic checksum-free 0x-address for a known EOA', () => {
    // Known-good vector: this is the same CREATE2 derivation Polymarket's own
    // frontend uses. Any EOA always maps to the same Safe address.
    const a = deriveSafeAddress('0x0000000000000000000000000000000000000001')
    const b = deriveSafeAddress('0x0000000000000000000000000000000000000001')
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('derives a different Safe address for a different EOA', () => {
    const a = deriveSafeAddress('0x0000000000000000000000000000000000000001')
    const b = deriveSafeAddress('0x0000000000000000000000000000000000000002')
    expect(a).not.toBe(b)
  })

  it('is case-insensitive on the input EOA', () => {
    // NOTE: the plan's original vector here ('0xabc0000000000000000000000000000000000a')
    // is malformed — only 38 hex chars, 2 short of a valid 20-byte address —
    // and ethers v6 throws INVALID_ARGUMENT on it rather than silently
    // accepting it. Using a correctly-padded 40-hex-char address instead;
    // the case-insensitivity intent is unchanged.
    const lower = deriveSafeAddress('0xabc0000000000000000000000000000000000000')
    const upper = deriveSafeAddress('0xABC0000000000000000000000000000000000000')
    expect(lower).toBe(upper)
  })
})
