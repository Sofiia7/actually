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
  /**
   * `reservedDay` (when present) identifies the UTC day this reservation was
   * charged against — pass it back to `release()` so a reservation that
   * straddles a UTC-midnight rollover doesn't refund into the wrong day's
   * budget. Optional so simple test doubles that don't model day rollover
   * can omit it.
   */
  reserve(sizeUsd: number): { ok: true; reservedDay?: string } | { ok: false; error: string }
  release(sizeUsd: number, reservedDay?: string): void
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

  let reservedDay: string | undefined
  if (deps.spendGuard) {
    const guard = deps.spendGuard.reserve(input.sizeUsd)
    if (!guard.ok) {
      return { ok: false, error: guard.error }
    }
    reservedDay = guard.reservedDay
  }

  let result: SignAndSubmitResult
  try {
    result = await deps.signAndSubmit(input)
  } catch (err) {
    deps.spendGuard?.release(input.sizeUsd, reservedDay)
    return { ok: false, error: String(err) }
  }

  if (!result.success) {
    // Rejected/failed order — give back the budget reserve() committed.
    deps.spendGuard?.release(input.sizeUsd, reservedDay)
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  return { ok: true, orderId: result.orderId }
}
