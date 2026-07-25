import { Wallet } from 'ethers'
import { assertValidPrivateKeyShape } from './validatePrivateKey'

/**
 * Signer shape @polymarket/clob-client-v2 feature-detects on: `_signTypedData`
 * (the ethers v5 method name, kept for SDK compatibility) and `getAddress`.
 * Mirrors the extension's WCSigner (extension/src/background/wallet.ts) but
 * signs against a local private key instead of a WalletConnect session — this
 * is what makes headless order placement possible with no human to approve
 * a wallet prompt.
 */
export class EthersKeySigner {
  private readonly wallet: Wallet

  constructor(privateKey: string) {
    // Validate shape before ethers ever sees the value — see
    // validatePrivateKey.ts for why this must happen here.
    assertValidPrivateKeyShape(privateKey)
    this.wallet = new Wallet(privateKey)
  }

  async getAddress(): Promise<string> {
    return this.wallet.getAddress()
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention
  async _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // ethers v6's signTypedData computes the primary type itself and does not
    // want EIP712Domain listed among the types — strip it before delegating.
    const { EIP712Domain: _domain, ...rest } = types
    return this.wallet.signTypedData(domain, rest, value)
  }
}
