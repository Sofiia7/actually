export interface CancelOrderInput {
  orderId: string
}

export interface CancelOrderDeps {
  privateKey: string | undefined
  cancelOrder: (orderId: string) => Promise<{ success: boolean; error?: string }>
}

export interface CancelOrderOutput {
  ok: boolean
  error?: string
}

export async function cancelOrder(deps: CancelOrderDeps, input: CancelOrderInput): Promise<CancelOrderOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }
  try {
    const result = await deps.cancelOrder(input.orderId)
    if (!result.success) return { ok: false, error: result.error ?? 'unknown_error' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
