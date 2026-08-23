import { describe, expect, it } from 'vitest'
import { redeemPosition } from './redeemPosition'
import type { Position } from '../positions'

// conditionId must be a real bytes32 hex string - ethers' ABI encoder rejects
// anything else, same as it would for a live call.
const COND = '0x' + '11'.repeat(32)

function position(over: Partial<Position> = {}): Position {
  return {
    tokenId: 'tok-yes',
    conditionId: COND,
    size: 40,
    avgPrice: 0.3,
    curPrice: 1,
    currentValue: 40,
    cashPnl: 28,
    percentPnl: 233,
    outcome: 'Yes',
    outcomeIndex: 0,
    negativeRisk: false,
    redeemable: true,
    title: 'Will X?',
    slug: 'x',
    ...over,
  }
}

describe('redeemPosition', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await redeemPosition(
      {
        privateKey: undefined,
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position()],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('returns position_not_found when nothing matches the conditionId', async () => {
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position({ conditionId: 'other' })],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('position_not_found')
  })

  it('returns not_yet_redeemable when the matching position has not resolved', async () => {
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position({ redeemable: false })],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_yet_redeemable')
  })

  it('submits the built transaction and returns the transaction id on success', async () => {
    let submittedTx: unknown
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position()],
        submit: async (tx) => {
          submittedTx = tx
          return { success: true, transactionId: 'tx-123' }
        },
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(true)
    expect(result.transactionId).toBe('tx-123')
    expect(submittedTx).toMatchObject({ to: expect.any(String), data: expect.any(String), value: '0' })
  })

  it('surfaces a relayer failure without throwing', async () => {
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position()],
        submit: async () => ({ success: false, error: 'relayer_state:STATE_FAILED' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('relayer_state:STATE_FAILED')
  })

  it('does not throw when a dependency rejects', async () => {
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => {
          throw new Error('funder_lookup_failed')
        },
        fetchPositions: async () => [position()],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('funder_lookup_failed')
  })

  it('includes both outcome positions when the caller holds both sides of a condition', async () => {
    let submittedTx: unknown
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [
          position({ outcomeIndex: 0, size: 5, negativeRisk: true }),
          position({ outcomeIndex: 1, size: 3, negativeRisk: true, tokenId: 'tok-no' }),
        ],
        submit: async (tx) => {
          submittedTx = tx
          return { success: true, transactionId: 'tx-both' }
        },
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(true)
    expect(submittedTx).toBeDefined()
  })
})

describe('redeemPosition - a resolved market is not the same as a payout', () => {
  it('refuses a losing position instead of paying to be told it is worthless', async () => {
    // data-api reports redeemable=true for the LOSING side as well, alongside
    // curPrice 0 and currentValue 0. Submitting anyway gets
    // "PRECHECK_SKIPPED: redeem skipped: zero position balance" from the
    // relayer, after the signature and against the builder's daily quota -
    // and an agent, unlike a person, will simply try again.
    let submitted = false
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position({ curPrice: 0, currentValue: 0, cashPnl: -12, percentPnl: -100 })],
        submit: async () => {
          submitted = true
          return { success: true, transactionId: 'tx1' }
        },
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('nothing_to_redeem')
    expect(submitted).toBe(false)
  })

  it('still redeems a winning position', async () => {
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [position({ curPrice: 1, currentValue: 40 })],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(true)
  })

  it('redeems when only one of several positions on the condition has value', async () => {
    // Holding both sides of a resolved market: one settles to $1, one to $0.
    const result = await redeemPosition(
      {
        privateKey: '0xkey',
        getFunderAddress: async () => '0xsafe',
        fetchPositions: async () => [
          position({ outcomeIndex: 0, curPrice: 0, currentValue: 0 }),
          position({ outcomeIndex: 1, curPrice: 1, currentValue: 15 }),
        ],
        submit: async () => ({ success: true, transactionId: 'tx1' }),
      },
      { conditionId: COND },
    )
    expect(result.ok).toBe(true)
  })
})
