import { buildRedeemTransaction, type EncodedRedeemTx } from '@actually/core'
import type { Position } from '../positions'

export interface RedeemPositionInput {
  /** From a prior get_positions() call — identifies which resolved market to redeem. */
  conditionId: string
}

export interface RedeemSubmitResult {
  success: boolean
  transactionId?: string
  error?: string
}

export interface RedeemPositionDeps {
  privateKey: string | undefined
  getFunderAddress: () => Promise<string>
  fetchPositions: (address: string) => Promise<Position[]>
  submit: (tx: EncodedRedeemTx) => Promise<RedeemSubmitResult>
}

export interface RedeemPositionOutput {
  ok: boolean
  transactionId?: string
  error?: string
}

// Mirrors placeOrder.ts/sellOrder.ts's error-normalization contract: every
// dependency failure (network, relayer, funder lookup) is caught and
// returned as a typed error, never an unhandled rejection.
export async function redeemPosition(deps: RedeemPositionDeps, input: RedeemPositionInput): Promise<RedeemPositionOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }

  try {
    const address = await deps.getFunderAddress()
    const allPositions = await deps.fetchPositions(address)
    const matching = allPositions.filter((p) => p.conditionId === input.conditionId)

    if (matching.length === 0) {
      return { ok: false, error: 'position_not_found' }
    }
    if (!matching.some((p) => p.redeemable)) {
      return { ok: false, error: 'not_yet_redeemable' }
    }
    // `redeemable` from data-api means "this market has resolved", NOT "there
    // is money here": it comes back true for holders of the LOSING side too,
    // with curPrice 0.0000 and currentValue 0.00 beside it. Without this
    // check the tool signs and submits a redeem that the relayer answers with
    // "PRECHECK_SKIPPED: redeem skipped: zero position balance" — burning a
    // signature and a slot of the builder's daily relayer quota to be told
    // there was nothing to collect. An agent, unlike a person, will retry it.
    if (!matching.some((p) => p.currentValue > 0 || p.curPrice > 0)) {
      return { ok: false, error: 'nothing_to_redeem' }
    }

    const tx = buildRedeemTransaction(
      input.conditionId,
      matching.map((p) => ({
        conditionId: p.conditionId,
        outcomeIndex: p.outcomeIndex,
        size: p.size,
        negativeRisk: p.negativeRisk,
      })),
    )

    const result = await deps.submit(tx)
    if (!result.success) {
      return { ok: false, error: result.error ?? 'unknown_error', transactionId: result.transactionId }
    }
    return { ok: true, transactionId: result.transactionId }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
