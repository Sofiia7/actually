import { minOrderShares } from '@actually/core'
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
  /** Market's minimum order size in shares; falls back to the platform default. */
  minOrderSize?: number
  /**
   * The resolved market's own (cached or live) price for this outcome, when
   * the caller has it. Used ONLY to floor the spend-guard's notional
   * estimate — never passed through to signing/submission, which still
   * honors the caller's `price` as the actual limit/floor. Without this, a
   * caller (or a prompt-injected agent) could quote an arbitrarily low
   * `price` to make a large sell look tiny to the guard while it actually
   * liquidates shares worth far more at the real market price.
   */
  marketPriceHint?: number
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

  // Same CLOB floor as place_order, but expressed directly here: a sell is
  // already denominated in shares, so no price conversion is involved. A
  // sub-minimum leftover position can't be sold at all — saying so up front
  // beats a signature followed by an opaque CLOB rejection.
  const minShares = minOrderShares(input.minOrderSize)
  if (input.sizeShares < minShares) {
    return { ok: false, error: `order_below_min_size:${minShares}` }
  }

  // Sells have no `sizeUsd` field (shares, not USD, is the natural close-a-
  // position unit) — estimate notional the same way the order form does, so
  // the same USD-denominated budget covers both buys and sells. Floor the
  // per-share price at the market's own price (when known) rather than
  // trusting the caller's `price` alone: for LIMIT that's a real resting
  // price the caller could still lowball, and for MARKET it's an explicit
  // worst-acceptable FLOOR the caller chooses — either way a caller-supplied
  // near-zero price must not make a large real-money sell look small to the
  // guard.
  const guardPrice = Math.max(input.price, input.marketPriceHint ?? 0)
  const estimatedUsd = input.sizeShares * guardPrice

  let reservedDay: string | undefined
  if (deps.spendGuard) {
    const guard = deps.spendGuard.reserve(estimatedUsd)
    if (!guard.ok) {
      return { ok: false, error: guard.error }
    }
    reservedDay = guard.reservedDay
  }

  let result: SignAndSubmitSellResult
  try {
    result = await deps.signAndSubmit(input)
  } catch (err) {
    deps.spendGuard?.release(estimatedUsd, reservedDay)
    return { ok: false, error: String(err) }
  }

  if (!result.success) {
    deps.spendGuard?.release(estimatedUsd, reservedDay)
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  return { ok: true, orderId: result.orderId }
}
