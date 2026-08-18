import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTradeLog, getTradeLog, logTrade } from './tradeLog'
import { MAX_TRADE_LOG_ITEMS } from '../shared/constants'

beforeEach(async () => {
  await clearTradeLog()
})

describe('tradeLog — the only local record that a trade happened', () => {
  it('keeps a sold position after it vanishes from the positions API', async () => {
    await logTrade({
      kind: 'SELL',
      status: 'placed',
      question: 'Will China invade Taiwan by end of 2026?',
      outcome: 'Yes',
      shares: 14.29,
      price: 0.14,
      usd: 2,
      orderType: 'MARKET',
      ref: '0xabc123',
    })
    const [entry] = await getTradeLog()
    expect(entry).toMatchObject({ kind: 'SELL', status: 'placed', shares: 14.29, ref: '0xabc123' })
    expect(entry.timestamp).toBeGreaterThan(0)
    expect(entry.id).toBeTruthy()
  })

  it('records failures too — "I clicked sell and it broke" is worth keeping', async () => {
    await logTrade({ kind: 'REDEEM', status: 'failed', question: 'Resolved market', error: 'relayer said 401' })
    const [entry] = await getTradeLog()
    expect(entry.status).toBe('failed')
    expect(entry.error).toContain('401')
  })

  it('puts the newest entry first', async () => {
    await logTrade({ kind: 'BUY', status: 'placed', question: 'first' })
    await logTrade({ kind: 'SELL', status: 'placed', question: 'second' })
    expect((await getTradeLog()).map((t) => t.question)).toEqual(['second', 'first'])
  })

  it('caps the log instead of growing without bound', async () => {
    for (let i = 0; i < MAX_TRADE_LOG_ITEMS + 5; i++) {
      await logTrade({ kind: 'BUY', status: 'placed', question: `q${i}` })
    }
    const items = await getTradeLog()
    expect(items).toHaveLength(MAX_TRADE_LOG_ITEMS)
    // The cap drops the OLDEST, not the newest.
    expect(items[0].question).toBe(`q${MAX_TRADE_LOG_ITEMS + 4}`)
  })

  it('never throws when storage fails — a logging problem must not fail a real trade', async () => {
    const set = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'))
    await expect(logTrade({ kind: 'BUY', status: 'placed', question: 'q' })).resolves.toBeUndefined()
  })

  it('tolerates a corrupted store rather than crashing the History tab', async () => {
    await chrome.storage.local.set({ tradeLog: 'not-an-array' })
    expect(await getTradeLog()).toEqual([])
  })
})
