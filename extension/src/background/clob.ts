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
} from '@polymarket/clob-client-v2'
import { BUILDER_CODE } from '../shared/constants'
import { WCSigner } from './wallet'

const CLOB_HOST = 'https://clob.polymarket.com'

/**
 * Resolve a user's Polymarket Safe (funder) address from their EOA.
 *
 * Polymarket creates a deterministic Gnosis Safe per EOA via CREATE2. The
 * canonical resolution uses Polymarket's own data API which avoids us
 * shipping the factory address / setup-bytes constants and tracking them
 * if they ever change.
 *
 * Endpoint shape (subject to change): GET clob.polymarket.com/proxy/<eoa>
 * Some integrations also use data.polymarket.com — both surfaces are
 * acceptable; whichever Polymarket continues to support.
 *
 * If we can't resolve (e.g. the user has never interacted with Polymarket
 * and no Safe exists yet), the caller must prompt them to sign in on
 * polymarket.com once before using the trade flow.
 */
export async function resolveFunderAddress(
  eoa: string,
  workerUrl: string,
  workerSecret: string,
): Promise<string> {
  // We route through the Worker to keep the extension's host_permissions
  // tight (CLOB is not in our allow-list). The Worker has a /clob/proxy
  // endpoint that forwards the lookup.
  const res = await fetch(`${workerUrl}/clob/proxy/${eoa.toLowerCase()}`, {
    headers: { 'X-Actually-Auth': workerSecret },
  })
  if (!res.ok) {
    throw new Error(`funder_lookup_failed:${res.status}`)
  }
  const data = (await res.json()) as { proxyWallet?: string; address?: string }
  const addr = data.proxyWallet ?? data.address
  if (!addr) {
    throw new Error('funder_not_found')
  }
  return addr.toLowerCase()
}

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
 */
export async function deriveCredentials(
  client: ClobClient,
): Promise<ApiKeyCreds> {
  return client.createOrDeriveApiKey()
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
}

export async function placeBuyOrder(
  client: ClobClient,
  args: BuyOrderArgs,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  if (!BUILDER_CODE) {
    return { success: false, error: 'builder_code_not_configured' }
  }

  const userOrder: UserOrderV2 = {
    tokenID: args.tokenId,
    price: args.price,
    size: args.size,
    side: Side.BUY,
    // Per-order override; redundant with builderConfig but explicit for
    // transparency.
    builderCode: BUILDER_CODE,
  }

  try {
    const signed = await client.createOrder(userOrder, {
      tickSize: '0.01',
      negRisk: args.negRisk ?? false,
    })
    const res = (await client.postOrder(signed, OrderType.GTC)) as {
      success?: boolean
      errorMsg?: string
      orderID?: string
    }
    if (res.success) {
      return { success: true, orderId: res.orderID }
    }
    return { success: false, error: res.errorMsg ?? 'clob_rejected' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
