import type { SpendGuardLike } from './placeOrder'

export interface SellOrderInput {
  marketId: string
  tokenId: string
  side: 'SELL_YES' | 'SELL_NO'
  /** Shares to sell — the position-closing counterpart of place_order's sizeUsd. */
  sizeShares: number
  /** LIMIT → resting limit price; MARKET → worst-acceptable floor price (0..1). */
  price: number
  orderType: 'LIMIT' | 'MARKET'
  negRisk: boolean
  tickSize?: string
}

export interface SignAndSubmitSellResult {
  success: boolean
  orderId?: string
  error?: string
}

export interface SellOrderDeps {
  privateKey: string | undefined
  signAndSubmit: (args: SellOrderInput) => Promise<SignAndSubmitSellResult>
  spendGuard?: SpendGuardLike
}

export interface SellOrderOutput {
  ok: boolean
  orderId?: string
  error?: string
}

// Mirrors placeOrder.ts's error-normalization contract — see its comment.
export async function sellOrder(deps: SellOrderDeps, input: SellOrderInput): Promise<SellOrderOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }

  if (deps.spendGuard) {
    // Sells have no `sizeUsd` field (shares, not USD, is the natural close-a-
    // position unit) — estimate notional the same way the order form does,
    // so the same USD-denominated budget covers both buys and sells.
    const estimatedUsd = input.sizeShares * input.price
    const guard = deps.spendGuard.check(estimatedUsd)
    if (!guard.ok) {
      return { ok: false, error: guard.error }
    }
  }

  let result: SignAndSubmitSellResult
  try {
    result = await deps.signAndSubmit(input)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  if (!result.success) {
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  deps.spendGuard?.record(input.sizeShares * input.price)

  return { ok: true, orderId: result.orderId }
}
