export interface PrepareOrderInput {
  tokenId: string
  side: 'BUY_YES' | 'BUY_NO'
  sizeUsd: number
  /** LIMIT → resting limit price; MARKET → worst-acceptable cap price (0..1). */
  price: number
  orderType: 'LIMIT' | 'MARKET'
  negRisk: boolean
  tickSize?: string
}

export interface PrepareOrderDeps {
  builderCode: string
}

export interface PrepareOrderOutput {
  ok: boolean
  error?: string
  unsignedOrder?: Record<string, unknown>
  warning?: string
}

const SIGN_UNCHANGED_WARNING =
  'This is an UNSIGNED order. builderCode is only preserved if you sign this ' +
  'exact object unchanged — a EIP-712 order-signing wallet must sign the ' +
  'object exactly as returned, with no fields added, removed, or reordered.'

export function prepareOrder(deps: PrepareOrderDeps, input: PrepareOrderInput): PrepareOrderOutput {
  if (!deps.builderCode) {
    return { ok: false, error: 'not_configured' }
  }

  if (input.orderType === 'MARKET') {
    return {
      ok: true,
      unsignedOrder: {
        tokenID: input.tokenId,
        amount: input.sizeUsd,
        side: 'BUY',
        orderType: 'FOK',
        builderCode: deps.builderCode,
        price: input.price,
      },
      warning: SIGN_UNCHANGED_WARNING,
    }
  }

  // Convert USD notional -> shares the signer would receive if filled at `price`.
  const size = Math.floor((input.sizeUsd / input.price) * 100) / 100
  return {
    ok: true,
    unsignedOrder: {
      tokenID: input.tokenId,
      price: input.price,
      size,
      side: 'BUY',
      builderCode: deps.builderCode,
    },
    warning: SIGN_UNCHANGED_WARNING,
  }
}
