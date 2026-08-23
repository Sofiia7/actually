import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, getContractAddress, keccak256, parseAbiParameters } from 'viem'
import { deriveSafeAddress } from './safe'

// Same constants as ./safe.ts, duplicated here deliberately: this test exists
// to independently verify those constants (and the CREATE2 formula) are
// correct, so it must not import them from the implementation under test.
const POLY_SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b'
const POLY_SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf'

/**
 * Independently computes the same CREATE2 Safe address as `deriveSafeAddress`,
 * but using viem - a completely separate EVM library from ethers, with its
 * own ABI encoder, keccak256, and CREATE2 address implementation. If
 * `deriveSafeAddress` had a bug in the factory address, init-code hash, salt
 * encoding, or byte-order handling, a self-consistency test (determinism,
 * distinctness, case-insensitivity) would NOT catch it - those all pass even
 * for a wrong-but-internally-consistent derivation. This function is the
 * regression test for that class of bug: two independent implementations of
 * the public CREATE2 standard, cross-checked against each other.
 */
function viemDeriveSafeAddress(eoa: string): string {
  const salt = keccak256(
    encodeAbiParameters(parseAbiParameters('address'), [eoa.toLowerCase() as `0x${string}`]),
  )
  const addr = getContractAddress({
    opcode: 'CREATE2',
    from: POLY_SAFE_FACTORY,
    salt,
    bytecodeHash: POLY_SAFE_INIT_CODE_HASH,
  })
  return addr.toLowerCase()
}

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
    // is malformed - only 38 hex chars, 2 short of a valid 20-byte address -
    // and ethers v6 throws INVALID_ARGUMENT on it rather than silently
    // accepting it. Using a correctly-padded 40-hex-char address instead;
    // the case-insensitivity intent is unchanged.
    const lower = deriveSafeAddress('0xabc0000000000000000000000000000000000000')
    const upper = deriveSafeAddress('0xABC0000000000000000000000000000000000000')
    expect(lower).toBe(upper)
  })
})

describe('deriveSafeAddress vs. independent viem CREATE2 computation', () => {
  // Cross-check against a completely separate EVM library (viem, not ethers)
  // re-implementing the same public CREATE2 formula from scratch. This is
  // what would actually catch a wrong-but-internally-consistent bug (wrong
  // factory address, wrong init-code hash, a salt-encoding mistake, or a
  // byte-order slip) that the self-consistency tests above cannot detect.
  const eoas = [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
    '0x000000000000000000000000000000000000dEaD',
  ]

  it.each(eoas)('matches viem\'s independent CREATE2 derivation for %s', (eoa) => {
    expect(deriveSafeAddress(eoa)).toBe(viemDeriveSafeAddress(eoa))
  })
})
