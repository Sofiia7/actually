import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import {
  OrderType,
  deriveCredentials,
  makeClient,
  signBuyOrder,
  signMarketBuyOrder,
  submitSignedOrder,
} from '../clobClient'
import { EthersKeySigner } from '../ethersKeySigner'
import type { PlaceOrderInput, SignAndSubmitResult } from './placeOrder'

/**
 * Builds the real signAndSubmit function for a given private key. Credential
 * derivation (createOrDeriveApiKey) involves an EIP-712 signature and a
 * network round-trip; it only needs to happen once per process, so the
 * result is memoized in a closure rather than re-derived on every order.
 */
export function makeSignAndSubmit(
  privateKey: string,
): (input: PlaceOrderInput) => Promise<SignAndSubmitResult> {
  const signer = new EthersKeySigner(privateKey)
  let credsPromise: Promise<ApiKeyCreds> | null = null

  async function getCreds(): Promise<ApiKeyCreds> {
    if (!credsPromise) {
      credsPromise = (async () => {
        const bootstrapClient = await makeClient({ signer })
        return deriveCredentials(bootstrapClient)
      })().catch((err: unknown) => {
        // Only a FAILED derivation clears the cache so the next call gets a
        // fresh attempt (transient CLOB API hiccup, network blip during the
        // EIP-712 round-trip). A successful derivation stays cached forever —
        // the credentials don't change, so there's never a reason to re-derive.
        credsPromise = null
        throw err
      })
    }
    return credsPromise
  }

  return async function signAndSubmit(input: PlaceOrderInput): Promise<SignAndSubmitResult> {
    const creds = await getCreds()
    const client = await makeClient({ signer, creds })
    const isMarket = input.orderType === 'MARKET'
    let signed: unknown
    if (isMarket) {
      signed = await signMarketBuyOrder(client, {
        tokenId: input.tokenId,
        sizeUsd: input.sizeUsd,
        capPrice: input.price,
        negRisk: input.negRisk,
        tickSize: input.tickSize,
      })
    } else {
      const size = Math.floor((input.sizeUsd / input.price) * 100) / 100
      signed = await signBuyOrder(client, {
        tokenId: input.tokenId,
        price: input.price,
        size,
        negRisk: input.negRisk,
        tickSize: input.tickSize,
      })
    }
    return submitSignedOrder(client, signed, isMarket ? OrderType.FOK : OrderType.GTC)
  }
}
