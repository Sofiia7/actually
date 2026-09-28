/**
 * Polymarket CLOB v2 client - built around `@polymarket/clob-client-v2`.
 *
 * Mirrors extension/src/background/clob.ts's makeClient / signBuyOrder /
 * signMarketBuyOrder / submitSignedOrder, but parameterized on
 * `EthersKeySigner` (a local-private-key signer, see ./ethersKeySigner.ts)
 * instead of the extension's WalletConnect-backed `WCSigner`, and on
 * mcp-server's own baked `BUILDER_CODE` (./config, Task 16) instead of the
 * extension's `import.meta.env`-derived one.
 *
 * There is no separate WalletConnect flow here - the signer's own EOA is all
 * there is, so the Polymarket Safe (funder) address is derived locally via
 * `deriveSafeAddress` rather than looked up or passed in externally.
 */
import {
  ClobClient,
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
} from '@polymarket/clob-client-v2'
import { classifyOrderPost, deriveSafeAddress } from '@actually/core'
import { BUILDER_CODE } from './config'
import type { EthersKeySigner } from './ethersKeySigner'

const CLOB_HOST = 'https://clob.polymarket.com'

export interface MakeClientArgs {
  signer: EthersKeySigner
  creds?: ApiKeyCreds
}

/** Resolve the caller's Polymarket Safe (funder) address from their EOA. */
export async function funderForSigner(signer: EthersKeySigner): Promise<string> {
  const eoa = await signer.getAddress()
  return deriveSafeAddress(eoa)
}

export async function makeClient({ signer, creds }: MakeClientArgs): Promise<ClobClient> {
  const funderAddress = await funderForSigner(signer)
  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funderAddress,
    // Default builderCode for orders that don't override it explicitly.
    builderConfig: BUILDER_CODE ? { builderCode: BUILDER_CODE } : undefined,
  })
}

/**
 * One-time-per-device flow: exchange the signer's EOA signature for CLOB API
 * key/secret/passphrase that authenticates all subsequent order submissions.
 *
 * SDK method names have drifted across versions. We probe the union of known
 * shapes (`createOrDeriveApiKey`, `deriveApiKey`, `createApiKey`) so a minor
 * SDK bump doesn't silently break onboarding. Whichever method exists is
 * called; all are expected to return ApiKeyCreds.
 */
export async function deriveCredentials(client: ClobClient): Promise<ApiKeyCreds> {
  const c = client as unknown as Record<string, undefined | ((this: ClobClient) => Promise<ApiKeyCreds>)>
  const fn = c.createOrDeriveApiKey ?? c.deriveApiKey ?? c.createApiKey
  if (typeof fn !== 'function') {
    throw new Error('clob_sdk_missing_api_key_method')
  }
  return fn.call(client)
}

/** CLOB tick fallback: neg-risk markets default to 0.001, others to 0.01. */
function fallbackTick(negRisk: boolean | undefined): string {
  return negRisk ? '0.001' : '0.01'
}

export interface BuyOrderArgs {
  tokenId: string
  /** Price per share in USDC (0..1) */
  price: number
  /** Order size in shares (USDC notional = price × size) */
  size: number
  /** True for neg-risk events (different tick/contract config) */
  negRisk?: boolean
  /**
   * Explicit tick size from the Gamma market record (e.g. "0.01" or
   * "0.001"). Optional - falls back to negRisk-based default below.
   * Hardcoding the wrong tick gets the order rejected as `invalid_tick`,
   * so prefer to pass the real value.
   */
  tickSize?: string
}

/**
 * Sign-only step. Returns the signed CLOB order object (EIP-712), or throws.
 * Split out from submission so callers can distinguish "signed but failed to
 * submit" from "never signed".
 */
export async function signBuyOrder(client: ClobClient, args: BuyOrderArgs): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')
  // SDK types tickSize as a closed union literal ('0.1' | '0.01' | ...). We
  // accept the string from Gamma at runtime - if Gamma ever returns an
  // unsupported value the SDK rejects with a clear error. The cast here is
  // to the SDK's CreateOrderOptions shape since v2 marks the second param
  // as Partial<...>.
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createOrder']>[1]
  return client.createOrder(
    { tokenID: args.tokenId, price: args.price, size: args.size, side: Side.BUY, builderCode: BUILDER_CODE },
    opts,
  )
}

export interface MarketBuyOrderArgs {
  tokenId: string
  /** USD notional to spend (SDK `amount` for a BUY market order). */
  sizeUsd: number
  /**
   * Worst-acceptable price cap (0..1). Passed to the SDK as the marketable
   * limit so a FOK can't fill above it - our slippage guard. Omit for an
   * uncapped market take.
   */
  capPrice?: number
  negRisk?: boolean
  tickSize?: string
}

/**
 * Sign-only step for a MARKET (FOK) buy. Mirrors signBuyOrder but uses the
 * SDK's market-order path: `amount` is USD notional, execution is fill-or-kill,
 * and `capPrice` (if given) bounds the fill price.
 */
export async function signMarketBuyOrder(client: ClobClient, args: MarketBuyOrderArgs): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createMarketOrder']>[1]
  return client.createMarketOrder(
    {
      tokenID: args.tokenId,
      amount: args.sizeUsd,
      side: Side.BUY,
      orderType: OrderType.FOK,
      builderCode: BUILDER_CODE,
      ...(args.capPrice != null ? { price: args.capPrice } : {}),
    },
    opts,
  )
}

/**
 * Submit-only step. Posts a previously-signed order to CLOB. `orderType` must
 * match how the order was built: GTC for a resting limit, FOK for a market buy.
 *
 * Mirrors extension/src/background/clob.ts. We don't enable `throwOnError`, so
 * the SDK resolves every failure instead of throwing, in shapes that mean
 * different things: a 200 with `success: false` and a 4xx `{ error, status }`
 * are the exchange saying no, while a lost response comes back as `{ error }`
 * with no status at all, and a 5xx or a "duplicate" (the SDK retries once by
 * itself) may sit on top of an order that was accepted. classifyOrderPost
 * (@actually/core) reads them, keeping the CLOB's own reason for the agent.
 *
 * `unknown: true` marks a result that is neither a confirmed fill nor a
 * confirmed rejection - including a throw, which can happen after the POST
 * went out. The exchange may already hold the order (2026-09-08 audit F03),
 * so callers must not release spend-guard budget for it. The first version of
 * this fix only caught the throw and an empty response; the lost-response
 * shape, the one that actually happens, still read as a rejection.
 */
export async function submitSignedOrder(
  client: ClobClient,
  signed: unknown,
  orderType: OrderType = OrderType.GTC,
): Promise<{ success: boolean; orderId?: string; error?: string; unknown?: boolean }> {
  let res: unknown
  try {
    // SDK type is `SignedOrder` - we passed it through `unknown` to keep the
    // sign/submit boundary explicit. Cast back here.
    res = await client.postOrder(signed as Parameters<ClobClient['postOrder']>[0], orderType)
  } catch (err) {
    return { success: false, error: String(err), unknown: true }
  }
  const outcome = classifyOrderPost(res)
  if (outcome.kind === 'accepted') return { success: true, orderId: outcome.orderId }
  if (outcome.kind === 'unknown') return { success: false, error: outcome.error, unknown: true }
  return { success: false, error: outcome.error }
}

export interface SellOrderArgs {
  tokenId: string
  /** Price per share in USDC (0..1) */
  price: number
  /** Shares to sell (not USD notional) */
  size: number
  negRisk?: boolean
  tickSize?: string
}

/** Sign-only step for a resting (GTC) SELL - the position-closing mirror of signBuyOrder. */
export async function signSellOrder(client: ClobClient, args: SellOrderArgs): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createOrder']>[1]
  return client.createOrder(
    { tokenID: args.tokenId, price: args.price, size: args.size, side: Side.SELL, builderCode: BUILDER_CODE },
    opts,
  )
}

export interface MarketSellOrderArgs {
  tokenId: string
  /** Shares to sell - the SDK's `amount` field means USD for BUY market orders but SHARES for SELL. */
  sizeShares: number
  /** Worst-acceptable price floor (0..1) so a FOK can't fill below it. */
  capPrice?: number
  negRisk?: boolean
  tickSize?: string
}

/** Sign-only step for a MARKET (FOK) SELL - the position-closing mirror of signMarketBuyOrder. */
export async function signMarketSellOrder(client: ClobClient, args: MarketSellOrderArgs): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createMarketOrder']>[1]
  return client.createMarketOrder(
    {
      tokenID: args.tokenId,
      amount: args.sizeShares,
      side: Side.SELL,
      orderType: OrderType.FOK,
      builderCode: BUILDER_CODE,
      ...(args.capPrice != null ? { price: args.capPrice } : {}),
    },
    opts,
  )
}

/**
 * Cancel a single resting order by id. Mirrors extension/src/background/clob.ts.
 *
 * The SDK's `cancelOrder` never throws on its own for a non-2xx response (our
 * `makeClient` doesn't set `throwOnError`) - a rejected/HTTP-failed cancel
 * resolves to `{ error, status }` (from clob-client-v2's axios error
 * handling), not an exception. And a *successful* cancel has no `success`
 * field at all: the real CLOB response shape is `{ canceled: string[],
 * not_canceled: Record<orderId, reason> }`. So this must inspect those
 * fields directly rather than a `success` flag that never actually appears.
 */
export async function cancelOrder(client: ClobClient, orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = (await client.cancelOrder({ orderID: orderId })) as
      | { canceled?: string[]; not_canceled?: Record<string, string>; error?: unknown; status?: number }
      | undefined
    if (!res) return { success: false, error: 'empty_response' }
    if (res.error !== undefined) {
      return { success: false, error: typeof res.error === 'string' ? res.error : JSON.stringify(res.error) }
    }
    if (res.not_canceled && Object.prototype.hasOwnProperty.call(res.not_canceled, orderId)) {
      return { success: false, error: res.not_canceled[orderId] || 'cancel_rejected' }
    }
    if (Array.isArray(res.canceled) && res.canceled.includes(orderId)) {
      return { success: true }
    }
    // Ambiguous response (neither confirmed canceled nor explicitly rejected)
    // - fail closed rather than silently report success on an unrecognized shape.
    return { success: false, error: 'cancel_unconfirmed' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export interface OpenOrderSummary {
  orderId: string
  marketId: string
  tokenId: string
  side: string
  price: string
  originalSize: string
  sizeMatched: string
  status: string
}

/** List the signer's resting orders, optionally filtered to one market. */
export async function listOpenOrders(client: ClobClient, marketId?: string): Promise<OpenOrderSummary[]> {
  const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined)
  return orders.map((o) => ({
    orderId: o.id,
    marketId: o.market,
    tokenId: o.asset_id,
    side: o.side,
    price: o.price,
    originalSize: o.original_size,
    sizeMatched: o.size_matched,
    status: o.status,
  }))
}

export { OrderType, Side }
