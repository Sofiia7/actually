import { describe, expect, it } from 'vitest'
import { Wallet, verifyTypedData } from 'ethers'
import { EthersKeySigner } from './ethersKeySigner'

// Well-known test private key (Hardhat's default account #0) - never used on
// any network that holds real funds; safe to hardcode in a test.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('EthersKeySigner', () => {
  it('getAddress returns the address derived from the private key', async () => {
    const signer = new EthersKeySigner(TEST_PRIVATE_KEY)
    const expected = await new Wallet(TEST_PRIVATE_KEY).getAddress()
    expect(await signer.getAddress()).toBe(expected)
  })

  it('_signTypedData produces a signature that recovers to the signer address', async () => {
    const signer = new EthersKeySigner(TEST_PRIVATE_KEY)
    const domain = { name: 'Test', version: '1', chainId: 137 }
    const types = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Order: [{ name: 'value', type: 'uint256' }],
    }
    const value = { value: 42 }
    const sig = await signer._signTypedData(domain, types, value)
    // ethers' verifyTypedData expects types WITHOUT the EIP712Domain entry -
    // the same shape EthersKeySigner itself must strip before calling
    // wallet.signTypedData (ethers infers the domain type internally).
    const { EIP712Domain: _domain, ...rest } = types
    const recovered = verifyTypedData(domain, rest, value, sig)
    expect(recovered.toLowerCase()).toBe((await signer.getAddress()).toLowerCase())
  })
})
