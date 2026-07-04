import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client-v2'
import {
  OrderType,
  cancelOrder as clobCancelOrder,
  deriveCredentials,
  funderForSigner,
  listOpenOrders as clobListOpenOrders,
  makeClient,
  signBuyOrder,
  signMarketBuyOrder,
  signMarketSellOrder,
  signSellOrder,
  submitSignedOrder,
  type OpenOrderSummary,
} from './clobClient'
import { EthersKeySigner } from './ethersKeySigner'
import type { PlaceOrderInput, SignAndSubmitResult } from './tools/placeOrder'
import type { SellOrderInput, SignAndSubmitSellResult } from './tools/sellOrder'

export interface TradingSession {
  signAndSubmitBuy: (input: PlaceOrderInput) => Promise<SignAndSubmitResult>
  signAndSubmitSell: (input: SellOrderInput) => Promise<SignAndSubmitSellResult>
  cancelOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>
  listOpenOrders: (marketId?: string) => Promise<OpenOrderSummary[]>
  getFunderAddress: () => Promise<string>
}

/**
 * One trading session per configured private key, shared by every trading
 * tool (place_order/sell_order/cancel_order/get_open_orders/get_positions).
 * Credential derivation (createOrDeriveApiKey) is an EIP-712 signature plus a
 * network round-trip; it happens once per process and is memoized here so
 * every tool reuses the same authenticated client instead of re-deriving.
 */
export function makeTradingSession(privateKey: string): TradingSession {
  const signer = new EthersKeySigner(privateKey)
  let credsPromise: Promise<ApiKeyCreds> | null = null

  async function getCreds(): Promise<ApiKeyCreds> {
    if (!credsPromise) {
      credsPromise = (async () => {
        const bootstrapClient = await makeClient({ signer })
        return deriveCredentials(bootstrapClient)
      })().catch((err: unknown) => {
        // Only a FAILED derivation clears the cache — see placeOrder's
        // original rationale (a transient CLOB hiccup shouldn't poison every
        // later call). A successful derivation stays cached forever.
        credsPromise = null
        throw err
      })
    }
    return credsPromise
  }

  async function getAuthedClient(): Promise<ClobClient> {
    const creds = await getCreds()
    return makeClient({ signer, creds })
  }

  return {
    async signAndSubmitBuy(input) {
      const client = await getAuthedClient()
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
    },

    async signAndSubmitSell(input) {
      const client = await getAuthedClient()
      const isMarket = input.orderType === 'MARKET'
      let signed: unknown
      if (isMarket) {
        signed = await signMarketSellOrder(client, {
          tokenId: input.tokenId,
          sizeShares: input.sizeShares,
          capPrice: input.price,
          negRisk: input.negRisk,
          tickSize: input.tickSize,
        })
      } else {
        signed = await signSellOrder(client, {
          tokenId: input.tokenId,
          price: input.price,
          size: input.sizeShares,
          negRisk: input.negRisk,
          tickSize: input.tickSize,
        })
      }
      return submitSignedOrder(client, signed, isMarket ? OrderType.FOK : OrderType.GTC)
    },

    async cancelOrder(orderId) {
      const client = await getAuthedClient()
      return clobCancelOrder(client, orderId)
    },

    async listOpenOrders(marketId) {
      const client = await getAuthedClient()
      return clobListOpenOrders(client, marketId)
    },

    async getFunderAddress() {
      return funderForSigner(signer)
    },
  }
}
