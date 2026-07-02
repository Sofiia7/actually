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

// Errors from deps.signAndSubmit (network failures, signer errors, etc.) are
// expected to be reported via the SignAndSubmitResult's success/error fields
// rather than thrown; the real wiring (EthersKeySigner + deriveCredentials +
// signBuyOrder/signMarketBuyOrder + submitSignedOrder from clobClient.ts) is
// assembled where this tool is registered, kept out of this file so the
// orchestration logic here stays testable without a real signer or network call.
export async function placeOrder(deps: PlaceOrderDeps, input: PlaceOrderInput): Promise<PlaceOrderOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }

  const result = await deps.signAndSubmit(input)
  if (!result.success) {
    return { ok: false, error: result.error ?? 'unknown_error' }
  }

  return { ok: true, orderId: result.orderId }
}
