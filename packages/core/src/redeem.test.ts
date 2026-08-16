import { describe, expect, it } from 'vitest'
import { buildRedeemTransaction, CTF_ADDRESS, NEG_RISK_ADAPTER_ADDRESS, type RedeemablePosition } from './redeem'
import { Interface } from 'ethers'

const CONDITION_ID = '0x' + '11'.repeat(32)

describe('buildRedeemTransaction', () => {
  it('targets the base CTF contract for a regular (non-neg-risk) market with index sets [1,2]', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 0, size: 40, negativeRisk: false },
    ]
    const tx = buildRedeemTransaction(CONDITION_ID, positions)
    expect(tx.to).toBe(CTF_ADDRESS)
    expect(tx.value).toBe('0')

    const iface = new Interface([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ])
    const decoded = iface.decodeFunctionData('redeemPositions', tx.data)
    expect(decoded.collateralToken.toLowerCase()).toBe('0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb')
    expect(decoded.parentCollectionId).toBe('0x' + '0'.repeat(64))
    expect(decoded.conditionId).toBe(CONDITION_ID)
    expect(decoded.indexSets.map(Number)).toEqual([1, 2])
  })

  it('does not need the actual held size for a regular-market redeem (burns full balance, no amount param)', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 1, size: 0.0001, negativeRisk: false },
    ]
    expect(() => buildRedeemTransaction(CONDITION_ID, positions)).not.toThrow()
  })

  it('targets the NegRiskAdapter for a neg-risk market, with the amount in the held outcome slot', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 0, size: 40, negativeRisk: true },
    ]
    const tx = buildRedeemTransaction(CONDITION_ID, positions)
    expect(tx.to).toBe(NEG_RISK_ADAPTER_ADDRESS)

    const iface = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)'])
    const decoded = iface.decodeFunctionData('redeemPositions', tx.data)
    expect(decoded.conditionId).toBe(CONDITION_ID)
    // 40 shares at 6-decimal (pUSD-matching) base units, in slot 0; slot 1 zeroed.
    expect(decoded.amounts.map(String)).toEqual(['40000000', '0'])
  })

  it('places the amount in slot 1 when the held outcome index is 1', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 1, size: 12.5, negativeRisk: true },
    ]
    const tx = buildRedeemTransaction(CONDITION_ID, positions)
    const iface = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)'])
    const decoded = iface.decodeFunctionData('redeemPositions', tx.data)
    expect(decoded.amounts.map(String)).toEqual(['0', '12500000'])
  })

  it('fills both slots when the caller somehow holds both outcomes of a neg-risk condition', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 0, size: 5, negativeRisk: true },
      { conditionId: CONDITION_ID, outcomeIndex: 1, size: 3, negativeRisk: true },
    ]
    const tx = buildRedeemTransaction(CONDITION_ID, positions)
    const iface = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)'])
    const decoded = iface.decodeFunctionData('redeemPositions', tx.data)
    expect(decoded.amounts.map(String)).toEqual(['5000000', '3000000'])
  })

  it('throws when given no positions', () => {
    expect(() => buildRedeemTransaction(CONDITION_ID, [])).toThrow('no_positions_for_condition')
  })

  it('throws when positions disagree on negativeRisk for the same conditionId (should never happen, but must not silently pick one)', () => {
    const positions: RedeemablePosition[] = [
      { conditionId: CONDITION_ID, outcomeIndex: 0, size: 5, negativeRisk: true },
      { conditionId: CONDITION_ID, outcomeIndex: 1, size: 3, negativeRisk: false },
    ]
    expect(() => buildRedeemTransaction(CONDITION_ID, positions)).toThrow('inconsistent_negative_risk_flag')
  })
})

describe('buildRedeemTransaction — float-noise hardening (2026-08-16)', () => {
  const iface = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)'])

  it('floors a float-noise tail beyond 6 decimals instead of throwing', () => {
    // Real data-api sizes go through JS floats; 129.16999999999999 has more
    // decimals than parseUnits(6) accepts and used to brick the redeem.
    const tx = buildRedeemTransaction(CONDITION_ID, [
      { conditionId: CONDITION_ID, outcomeIndex: 0, size: 129.16999999999999, negativeRisk: true },
    ])
    const decoded = iface.decodeFunctionData('redeemPositions', tx.data)
    // Floored, never rounded up: over-asking the adapter reverts on-chain.
    expect(String(decoded.amounts[0])).toBe('129169999')
  })

  it('rejects a nonsensical size rather than encoding it', () => {
    expect(() =>
      buildRedeemTransaction(CONDITION_ID, [
        { conditionId: CONDITION_ID, outcomeIndex: 0, size: Number.NaN, negativeRisk: true },
      ]),
    ).toThrow(/invalid_size/)
  })

  it('rejects a missing outcomeIndex (mapped to -1 upstream) instead of redeeming slot 0', () => {
    expect(() =>
      buildRedeemTransaction(CONDITION_ID, [
        { conditionId: CONDITION_ID, outcomeIndex: -1, size: 5, negativeRisk: true },
      ]),
    ).toThrow('invalid_outcome_index:-1')
  })
})
