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

export interface PlaceOrderDeps {
  privateKey: string | undefined
  signAndSubmit: (args: PlaceOrderInput) => Promise<SignAndSubmitResult>
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

  let result: SignAndSubmitResult
  try {
    result = await deps.signAndSubmit(input)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  if (!result.success) {
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  return { ok: true, orderId: result.orderId }
}
