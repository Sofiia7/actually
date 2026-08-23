import { getCreate2Address, keccak256, AbiCoder } from 'ethers'

// Polymarket's Safe (funder) is created deterministically per EOA via CREATE2
// from its Safe factory on Polygon. We compute it locally - Polymarket retired
// the data-api EOA→proxy lookup endpoints (they now 404), and there is no public
// EOA→proxy API; their own frontend derives it client-side. This is the exact
// derivation `@polymarket/builder-relayer-client`'s deriveSafe uses, verified
// bit-for-bit against viem's getCreate2Address.
const POLY_SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b'
const POLY_SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf'

/**
 * Resolve a user's Polymarket Safe (funder) address from their EOA.
 * Deterministic CREATE2 derivation - the same address Polymarket itself uses,
 * computed locally with no network call. Works whether or not the Safe is
 * deployed yet; if the user has never funded their Polymarket account the
 * address is still correct, an order just fails later on insufficient balance.
 *
 * Accepts an EOA in any case (checksummed or not); normalizes internally.
 */
export function deriveSafeAddress(eoa: string): string {
  // Lowercase first: ethers v6's AbiCoder rejects mixed-case addresses that
  // don't happen to satisfy EIP-55 checksum validation (it won't silently
  // normalize them), so a mixed-case-but-not-checksummed input like
  // '0xABC...00A' would otherwise throw INVALID_ARGUMENT.
  const salt = keccak256(AbiCoder.defaultAbiCoder().encode(['address'], [eoa.toLowerCase()]))
  return getCreate2Address(POLY_SAFE_FACTORY, salt, POLY_SAFE_INIT_CODE_HASH).toLowerCase()
}
