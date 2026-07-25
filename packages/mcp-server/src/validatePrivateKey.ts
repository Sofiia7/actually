/**
 * A 32-byte hex private key, optionally 0x-prefixed. Anything else — most
 * commonly a pasted BIP-39 seed phrase, a truncated/typo'd key, or stray
 * whitespace/quotes — must be rejected BEFORE it reaches ethers' `Wallet`
 * constructor.
 *
 * ethers echoes the invalid input VERBATIM into the thrown error message for
 * any non-hex value (`invalid BytesLike value ... value="<the secret>"`).
 * That error is unhandled at the call sites (module-load time for the CLOB
 * signer, tool-output time for the relayer), so it lands in MCP host logs or
 * the calling agent's context — a real secret that controls the entire
 * wallet (a seed phrase controls far more than just this key) leaking into
 * plaintext logs on an npm-published package aimed at exactly the audience
 * likely to make this mistake.
 */
const PRIVATE_KEY_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/

export function assertValidPrivateKeyShape(key: string): void {
  if (!PRIVATE_KEY_SHAPE.test(key)) {
    throw new Error(
      'POLYMARKET_PRIVATE_KEY is not a valid 32-byte hex private key (64 hex ' +
        'characters, optionally 0x-prefixed). If you pasted a seed phrase, ' +
        'derive the raw private key from it instead — never paste a seed ' +
        'phrase into this variable.',
    )
  }
}
