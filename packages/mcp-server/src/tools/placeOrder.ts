export interface PlaceOrderInput {
  marketId: string
  tokenId: string
  side: 'BUY_YES' | 'BUY_NO'
  sizeUsd: number
  /** LIMIT → resting limit price; MARKET → worst-acceptable cap price (0..1). */
  price: number
  orderType: 'LIMIT' | 'MARKET'
  negRisk: boolean
  tickSize?: string
}

export interface SignAndSubmitResult {
  success: boolean
  orderId?: string
  error?: string
}

export interface SpendGuardLike {
  check(sizeUsd: number): { ok: true } | { ok: false; error: string }
  record(sizeUsd: number): void
}

export interface PlaceOrderDeps {
  privateKey: string | undefined
  signAndSubmit: (args: PlaceOrderInput) => Promise<SignAndSubmitResult>
  /**
   * Backstop against a prompt-injected or buggy calling agent placing
   * unbounded real-money orders. Optional only so existing unit tests that
   * don't care about spend limits stay minimal — index.ts always wires a
   * real one in production.
   */
  spendGuard?: SpendGuardLike
}

export interface PlaceOrderOutput {
  ok: boolean
  orderId?: string
  error?: string
}

// deps.signAndSubmit is preferably expected to report failures via the
// SignAndSubmitResult's success/error fields rather than throwing, but that's
// not guaranteed — e.g. clobClient.ts's signBuyOrder/signMarketBuyOrder throw
// (rather than returning a failure object) when BUILDER_CODE isn't
// configured. The try/catch below normalizes either failure mode into the
// same PlaceOrderOutput shape, so callers (and Task 26's real wiring) never
// need to worry about an unhandled rejection escaping this function.
export async function placeOrder(deps: PlaceOrderDeps, input: PlaceOrderInput): Promise<PlaceOrderOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }

  if (deps.spendGuard) {
    const guard = deps.spendGuard.check(input.sizeUsd)
    if (!guard.ok) {
      return { ok: false, error: guard.error }
    }
  }

  let result: SignAndSubmitResult
  try {
    result = await deps.signAndSubmit(input)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  if (!result.success) {
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  // Only a CONFIRMED submit counts against the daily total — a rejected or
  // failed order (caught above) must not consume the operator's budget.
  deps.spendGuard?.record(input.sizeUsd)

  return { ok: true, orderId: result.orderId }
}
