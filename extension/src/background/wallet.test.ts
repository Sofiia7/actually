import { describe, expect, it } from 'vitest'
import { buildDomainType } from './wallet'

describe('buildDomainType', () => {
  it('builds the full EIP712Domain type in canonical field order for a CTF Exchange domain', () => {
    // This is the exact shape clob-client-v2 passes for order signing after it
    // deletes types.EIP712Domain — WalletConnect/MetaMask need it rebuilt or
    // they hash an empty domain separator and every signature is invalid.
    expect(
      buildDomainType({
        name: 'Polymarket CTF Exchange',
        version: '1',
        chainId: 137,
        verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      }),
    ).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ])
  })

  it('omits fields absent from the domain (e.g. ClobAuth has no verifyingContract/salt)', () => {
    expect(buildDomainType({ name: 'ClobAuthDomain', version: '1', chainId: 137 })).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ])
  })

  it('includes salt when present, in canonical trailing position', () => {
    expect(
      buildDomainType({
        name: 'X',
        version: '1',
        chainId: 137,
        verifyingContract: '0xabc',
        salt: '0xdead',
      }),
    ).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
    ])
  })

  it('returns an empty array for an empty domain rather than throwing', () => {
    expect(buildDomainType({})).toEqual([])
  })
})
