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
 * DERIVE IS TRIED FIRST, AND THE ORDER IS THE POINT. Each of these SDK calls
 * builds L1 auth headers, and building them costs one `eth_signTypedData_v4`
 * — i.e. one wallet prompt the user has to approve. The SDK's own
 * `createOrDeriveApiKey` helper POSTs *create* first and only falls back to
 * derive when that comes back without a key. But create fails for any address
 * that already has a CLOB key — which is everyone who has ever connected
 * before, here or on polymarket.com — so the helper's normal path is
 * create-then-derive: two prompts, every single connect, for the same one
 * credential. Derive alone succeeds for those users in one prompt, and a
 * genuinely new key still gets created by the fallback below.
 *
 * The list is also why method names are probed rather than called directly:
 * they have drifted across SDK versions, so a minor bump can't silently break
 * onboarding.
 */
export async function deriveCredentials(
  client: ClobClient,
): Promise<ApiKeyCreds> {
  type KeyFn = (this: ClobClient) => Promise<ApiKeyCreds>
  const c = client as unknown as Record<string, undefined | KeyFn>
  const attempts: Array<{ name: string; fn: KeyFn }> = []
  for (const name of ['deriveApiKey', 'createApiKey', 'createOrDeriveApiKey']) {
    const fn = c[name]
    if (typeof fn === 'function') attempts.push({ name, fn })
  }

  if (attempts.length === 0) {
    throw new Error('clob_sdk_missing_api_key_method')
  }

  const failures: string[] = []
  for (const { name, fn } of attempts) {
    let creds: ApiKeyCreds | undefined
    try {
      creds = await fn.call(client)
    } catch (err) {
      failures.push(`${name}:${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // A non-2xx resolves to an error object rather than throwing (we don't
    // set the SDK's `throwOnError`), so "returned something" is not the same
    // as "returned credentials" — check the fields we actually need.
    if (creds?.key && creds.secret && creds.passphrase) return creds
    failures.push(`${name}:empty_credentials`)
  }
  throw new Error(`clob_api_key_failed:${failures.join('; ')}`)
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
 *
 * Two distinct failure shapes have to be read here (same trap as cancelOrder
 * below): a *logical* rejection comes back HTTP 200 as
 * `{ success: false, errorMsg }`, but a rejection the CLOB answers with a
 * non-2xx status never sets either field — `makeClient` doesn't enable
 * `throwOnError`, so clob-client-v2's errorHandling() resolves it to
 * `{ error, status }` instead. Reading only `errorMsg` collapsed every one of
 * those (below-minimum size, insufficient balance/allowance, bad tick, market
 * not accepting orders) into a bare "clob_rejected" with the actual reason
 * discarded — the user signed, paid nothing, and learned nothing.
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
    )) as
      // `status` is typed `string` on the SDK's success shape (e.g. "matched"),
      // but the axios-error shape puts the numeric HTTP status in the same
      // field — hence the union.
      | { success?: boolean; errorMsg?: string; orderID?: string; error?: unknown; status?: number | string }
      | undefined
    if (!res) return { success: false, error: 'empty_response' }
    if (res.success) return { success: true, orderId: res.orderID }
    return { success: false, error: clobErrorText(res) ?? 'clob_rejected' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Pull a human-meaningful reason out of either CLOB failure shape, or null
 * when the response genuinely carries none. Shared by the order path so a new
 * response shape only has to be taught here once.
 */
function clobErrorText(res: {
  errorMsg?: string
  error?: unknown
  status?: number | string
}): string | null {
  if (typeof res.errorMsg === 'string' && res.errorMsg.trim() !== '') return res.errorMsg
  if (typeof res.error === 'string' && res.error.trim() !== '') return res.error
  if (res.error !== undefined && res.error !== null) return JSON.stringify(res.error)
  if (typeof res.status === 'number') return `clob_http_${res.status}`
  if (typeof res.status === 'string' && res.status.trim() !== '') return `clob_status_${res.status}`
  return null
}

/**
 * Cancel a single resting order by id. Mirrors packages/mcp-server/src/clobClient.ts.
 *
 * The SDK's `cancelOrder` never throws on its own for a non-2xx response (our
 * `makeClient` doesn't set `throwOnError`) — a rejected/HTTP-failed cancel
 * resolves to `{ error, status }` (from clob-client-v2's axios error
 * handling), not an exception. And a *successful* cancel has no `success`
 * field at all: the real CLOB response shape is `{ canceled: string[],
 * not_canceled: Record<orderId, reason> }`. So this must inspect those
 * fields directly rather than a `success` flag that never actually appears.
 */
export async function cancelOrder(
  client: ClobClient,
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
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
    // — fail closed rather than silently report success on an unrecognized shape.
    return { success: false, error: 'cancel_unconfirmed' }
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
    outcome: o.outcome,
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
