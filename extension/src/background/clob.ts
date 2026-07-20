/**
 * Polymarket CLOB v2 client — built around `@polymarket/clob-client-v2`.
 *
 * Responsibility:
 *   - Initialize ClobClient with our build-time BUILDER_CODE
 *   - Derive (or restore) per-user API credentials (key/secret/passphrase)
 *   - Persist creds to chrome.storage.local so the user signs once per device
 *   - Expose typed helpers used by trade.ts and the Trade tab
 *
 * Heavy lift — order construction + EIP-712 signing — is done inside the SDK
 * against the WCSigner we hand it (see ./wallet.ts).
 */
import {
  ClobClient,
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type OrderBookSummary,
  type UserOrderV2,
  type UserMarketOrderV2,
} from '@polymarket/clob-client-v2'
import { BUILDER_CODE } from '../shared/constants'
import type { OpenOrderSummary } from '../shared/types'
import { WCSigner } from './wallet'

const CLOB_HOST = 'https://clob.polymarket.com'

/**
 * Architectural note (v1, deliberate deviation from spec §9):
 *
 * Orders go directly from the extension to https://clob.polymarket.com,
 * NOT through the Cloudflare Worker. The spec originally called for a
 * `/clob/order` Worker proxy so we'd have a single rate-limit / CORS
 * perimeter. For v1 we ship without it because:
 *
 *   1. CLOB itself authenticates each request via per-user HMAC headers
 *      (`POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_SIGNATURE`) that the SDK
 *      builds from creds derived during connect. The Worker cannot
 *      meaningfully validate or re-sign these — it would be a pass-through.
 *   2. Wrapping every CLOB GET (orderbook, prices, status polling) through
 *      Worker would multiply latency and force us to keep Worker rate
 *      limits high enough to not break real users' polling, which neuters
 *      the rate-limit-as-DoS-protection idea.
 *   3. Removes one moving part for v1 review/beta.
 *
 * The cost is `host_permissions: ["https://clob.polymarket.com/*"]` in
 * manifest.json — a single, public, well-known host. Reviewable.
 *
 * Planned for v1.2: re-introduce the Worker proxy when we also add HMAC
 * signing on `X-Actually-*` headers so the Worker leg adds real value
 * (per-IP order-rate limit, server-side geo re-check on submit).
 */

export interface InitClientArgs {
  signer: WCSigner
  funderAddress: string
  creds?: ApiKeyCreds
}

export function makeClient({
  signer,
  funderAddress,
  creds,
}: InitClientArgs): ClobClient {
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
 * One-time-per-device flow: the user signs a message; we exchange that for
 * CLOB API key/secret/passphrase that authenticates all subsequent order
 * submissions for this EOA.
 *
 * SDK method names have drifted across versions. We probe the union of known
 * shapes (`createOrDeriveApiKey`, `deriveApiKey`, `createApiKey`) so a minor
 * SDK bump doesn't silently break onboarding. Whichever method exists is
 * called; all are expected to return ApiKeyCreds.
 */
export async function deriveCredentials(
  client: ClobClient,
): Promise<ApiKeyCreds> {
  const c = client as unknown as Record<string, undefined | ((this: ClobClient) => Promise<ApiKeyCreds>)>
  const fn =
    c.createOrDeriveApiKey ??
    c.deriveApiKey ??
    c.createApiKey
  if (typeof fn !== 'function') {
    throw new Error('clob_sdk_missing_api_key_method')
  }
  return fn.call(client)
}

export async function fetchOrderBook(
  client: ClobClient,
  tokenId: string,
): Promise<OrderBookSummary> {
  return client.getOrderBook(tokenId)
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
   * "0.001"). Optional — falls back to negRisk-based default below.
   * Hardcoding the wrong tick gets the order rejected as `invalid_tick`,
   * so prefer to pass the real value.
   */
  tickSize?: string
}

/** CLOB tick fallback: neg-risk markets default to 0.001, others to 0.01. */
function fallbackTick(negRisk: boolean | undefined): string {
  return negRisk ? '0.001' : '0.01'
}

/**
 * Sign-only step. Returns the signed CLOB order object (EIP-712), or throws.
 * Split out from submission so telemetry can mark `order_signed` precisely
 * between signature and network post (the user may abort the wallet prompt;
 * we want to distinguish "signed but failed to submit" from "never signed").
 */
export async function signBuyOrder(
  client: ClobClient,
  args: BuyOrderArgs,
): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')

  const userOrder: UserOrderV2 = {
    tokenID: args.tokenId,
    price: args.price,
    size: args.size,
    side: Side.BUY,
    // Per-order override; redundant with builderConfig but explicit for
    // transparency.
    builderCode: BUILDER_CODE,
  }
  // SDK types tickSize as a closed union literal ('0.1' | '0.01' | ...).
  // We accept the string from Gamma at runtime — if Gamma ever returns
  // an unsupported value the SDK rejects with a clear error. The cast
  // here is to the SDK's CreateOrderOptions shape since v2 marks the
  // second param as Partial<...>.
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createOrder']>[1]
  return client.createOrder(userOrder, opts)
}

export interface MarketBuyOrderArgs {
  tokenId: string
  /** USD notional to spend (SDK `amount` for a BUY market order). */
  sizeUsd: number
  /**
   * Worst-acceptable price cap (0..1). Passed to the SDK as the marketable
   * limit so a FOK can't fill above it — our slippage guard. Omit for an
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
export async function signMarketBuyOrder(
  client: ClobClient,
  args: MarketBuyOrderArgs,
): Promise<unknown> {
  if (!BUILDER_CODE) throw new Error('builder_code_not_configured')

  const userMarketOrder: UserMarketOrderV2 = {
    tokenID: args.tokenId,
    amount: args.sizeUsd,
    side: Side.BUY,
    orderType: OrderType.FOK,
    builderCode: BUILDER_CODE,
    ...(args.capPrice != null ? { price: args.capPrice } : {}),
  }
  const opts = {
    tickSize: args.tickSize ?? fallbackTick(args.negRisk),
    negRisk: args.negRisk ?? false,
  } as Parameters<ClobClient['createMarketOrder']>[1]
  return client.createMarketOrder(userMarketOrder, opts)
}

/**
 * Submit-only step. Posts a previously-signed order to CLOB. `orderType` must
 * match how the order was built: GTC for a resting limit, FOK for a market buy.
 */
export async function submitSignedOrder(
  client: ClobClient,
  signed: unknown,
  orderType: OrderType = OrderType.GTC,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    // SDK type is `SignedOrder` — we passed it through `unknown` to keep
    // the sign/submit boundary explicit. Cast back here.
    const res = (await client.postOrder(
      signed as Parameters<ClobClient['postOrder']>[0],
      orderType,
    )) as { success?: boolean; errorMsg?: string; orderID?: string }
    if (res.success) return { success: true, orderId: res.orderID }
    return { success: false, error: res.errorMsg ?? 'clob_rejected' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Cancel a single resting order by id. Mirrors packages/mcp-server/src/clobClient.ts. */
export async function cancelOrder(
  client: ClobClient,
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = (await client.cancelOrder({ orderID: orderId })) as { success?: boolean; errorMsg?: string } | undefined
    if (res && res.success === false) return { success: false, error: res.errorMsg ?? 'cancel_rejected' }
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** List the signer's resting orders, optionally filtered to one market. Mirrors packages/mcp-server/src/clobClient.ts. */
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

/**
 * Poll the CLOB for an order's filled status. Used to fire the `order_filled`
 * telemetry event after a successful submit. The SDK's method name has drifted
 * across versions, so we probe a small union. Stops on `filled`/`cancelled`/
 * `expired` or after `maxMs` (default 60s).
 */
export async function pollOrderStatus(
  client: ClobClient,
  orderId: string,
  maxMs = 60_000,
): Promise<'matched' | 'cancelled' | 'expired' | 'unknown'> {
  const c = client as unknown as Record<
    string,
    undefined | ((id: string) => Promise<{ status?: string }>)
  >
  const getter = c.getOrder ?? c.getOrderStatus
  if (typeof getter !== 'function') return 'unknown'
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const r = await getter.call(client, orderId)
      const s = (r?.status ?? '').toLowerCase()
      if (s === 'matched' || s === 'filled') return 'matched'
      if (s === 'cancelled' || s === 'canceled') return 'cancelled'
      if (s === 'expired') return 'expired'
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return 'unknown'
}
