import { Interface, parseUnits } from 'ethers'

/**
 * Polygon mainnet (chain 137) contract addresses for redeeming resolved
 * Polymarket positions. Verified against PolygonScan's contract ABI and
 * docs.polymarket.com/resources/contracts + docs.polymarket.com/developers/CTF/redeem
 * on 2026-07-05 — re-verify if Polymarket migrates contracts again.
 */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
export const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
/** pUSD — the collateral token Polymarket outcome tokens redeem into. 6 decimals, same as legacy USDC.e. */
export const COLLATERAL_TOKEN_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
export const COLLATERAL_DECIMALS = 6
const PARENT_COLLECTION_ID = ('0x' + '0'.repeat(64)) as `0x${string}`

const CTF_INTERFACE = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
])
const NEG_RISK_INTERFACE = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)'])

export interface RedeemablePosition {
  conditionId: string
  /** 0 or 1 — which binary outcome slot this position's tokens occupy. */
  outcomeIndex: number
  /** Held size in shares (human units, e.g. 40.5) — NOT base units. */
  size: number
  negativeRisk: boolean
}

export interface EncodedRedeemTx {
  to: string
  data: string
  value: string
}

/**
 * Builds the on-chain redeem call for one conditionId. `positions` is every
 * position the caller holds for that condition (normally one, occasionally
 * two if they somehow hold both outcomes). Two entirely different contracts
 * and calling conventions depending on `negativeRisk`:
 *
 * - Regular markets: base CTF contract, indexSets=[1,2] burns the caller's
 *   ENTIRE held balance for both outcome slots (whichever they actually
 *   hold) — there's no amount parameter, so the held `size` doesn't matter.
 * - Neg-risk markets: NegRiskAdapter, which takes explicit per-slot amounts
 *   in base units (6 decimals, matching pUSD) — slot = outcomeIndex, the
 *   other slot zeroed unless the caller holds both.
 */
export function buildRedeemTransaction(conditionId: string, positions: RedeemablePosition[]): EncodedRedeemTx {
  if (positions.length === 0) {
    throw new Error('no_positions_for_condition')
  }
  const negativeRisk = positions[0].negativeRisk
  if (positions.some((p) => p.negativeRisk !== negativeRisk)) {
    throw new Error('inconsistent_negative_risk_flag')
  }

  if (!negativeRisk) {
    const data = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
      COLLATERAL_TOKEN_ADDRESS,
      PARENT_COLLECTION_ID,
      conditionId,
      [1, 2],
    ])
    return { to: CTF_ADDRESS, data, value: '0' }
  }

  const amounts: [bigint, bigint] = [0n, 0n]
  for (const p of positions) {
    if (p.outcomeIndex !== 0 && p.outcomeIndex !== 1) {
      throw new Error(`invalid_outcome_index:${p.outcomeIndex}`)
    }
    amounts[p.outcomeIndex as 0 | 1] = parseUnits(p.size.toString(), COLLATERAL_DECIMALS)
  }
  const data = NEG_RISK_INTERFACE.encodeFunctionData('redeemPositions', [conditionId, amounts])
  return { to: NEG_RISK_ADAPTER_ADDRESS, data, value: '0' }
}
