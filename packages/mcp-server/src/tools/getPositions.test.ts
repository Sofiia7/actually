import { describe, expect, it } from 'vitest'
import { getPositions } from './getPositions'

describe('getPositions', () => {
  it('returns not_configured when no private key is present', async () => {
    const result = await getPositions({
      privateKey: undefined,
      getFunderAddress: async () => '0xabc',
      fetchPositions: async () => [],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_configured')
  })

  it('resolves the funder address and returns its positions', async () => {
    let queriedAddress: string | undefined
    const result = await getPositions({
      privateKey: '0xkey',
      getFunderAddress: async () => '0xsafe',
      fetchPositions: async (addr) => {
        queriedAddress = addr
        return [{ tokenId: 'tok-yes', conditionId: 'c1', size: 10, avgPrice: 0.3, curPrice: 0.4, currentValue: 4, cashPnl: 1, percentPnl: 33, outcome: 'Yes', title: 'Will X?', slug: 'x' }]
      },
    })
    expect(queriedAddress).toBe('0xsafe')
    expect(result.ok).toBe(true)
    expect(result.positions).toHaveLength(1)
    expect(result.positions?.[0].tokenId).toBe('tok-yes')
  })

  it('surfaces a fetch failure without throwing', async () => {
    const result = await getPositions({
      privateKey: '0xkey',
      getFunderAddress: async () => '0xsafe',
      fetchPositions: async () => {
        throw new Error('positions_fetch_failed:500')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('positions_fetch_failed')
  })
})
