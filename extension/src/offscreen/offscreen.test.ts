import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WalletState } from '../background/trade'

vi.mock('../background/trade', () => ({
  restoreWallet: vi.fn(),
  placeOrder: vi.fn(),
  sellOrder: vi.fn(),
  cancelOrder: vi.fn(),
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  getOpenOrders: vi.fn(),
  getOrderbookSnapshot: vi.fn(),
}))
vi.mock('../background/redeem', () => ({ redeemPosition: vi.fn() }))
vi.mock('../background/positions', () => ({ fetchPositions: vi.fn() }))
vi.mock('../background/settings', () => ({ getSettings: vi.fn() }))
vi.mock('../background/tradeLog', () => ({ logTrade: vi.fn() }))

import { handle } from './offscreen'
import { placeOrder, restoreWallet, sellOrder } from '../background/trade'
import { redeemPosition } from '../background/redeem'
import { fetchPositions } from '../background/positions'
import { getSettings } from '../background/settings'
import { logTrade } from '../background/tradeLog'

const fakeWallet: WalletState = {
  topic: 't1',
  address: '0xaddr',
  safeAddress: '0xsafe',
  creds: { key: 'k', secret: 's', passphrase: 'p' },
} as WalletState

afterEach(() => {
  vi.clearAllMocks()
})

describe('offscreen handle() - trade logging outlives the popup (2026-09-08 audit F13)', () => {
  it('OS_PLACE_ORDER logs the trade itself on success, before the popup could ever see the response', async () => {
    vi.mocked(restoreWallet).mockResolvedValue(fakeWallet)
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, orderId: 'order-1' })

    await handle({
      target: 'offscreen',
      type: 'OS_PLACE_ORDER',
      args: {
        tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 20, price: 0.25, negRisk: false,
        orderType: 'MARKET', question: 'Will it happen?', marketSlug: 'will-it-happen', outcome: 'Yes',
      },
    })

    expect(logTrade).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'BUY', status: 'placed', question: 'Will it happen?', marketSlug: 'will-it-happen',
      outcome: 'Yes', orderType: 'MARKET', usd: 20, price: 0.25, ref: 'order-1',
    }))
  })

  it('OS_SELL_ORDER logs a failed trade too - a lost result is exactly what F13 is about', async () => {
    vi.mocked(restoreWallet).mockResolvedValue(fakeWallet)
    vi.mocked(sellOrder).mockResolvedValue({ ok: false, error: 'insufficient_shares' })

    await handle({
      target: 'offscreen',
      type: 'OS_SELL_ORDER',
      args: {
        tokenId: 'tok-yes', sizeShares: 40, price: 0.3, orderType: 'LIMIT',
        question: 'Will it happen?', marketSlug: 'will-it-happen', outcome: 'Yes',
      },
    })

    expect(logTrade).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'SELL', status: 'failed', question: 'Will it happen?', outcome: 'Yes',
      shares: 40, price: 0.3, error: 'insufficient_shares',
    }))
  })

  it('OS_REDEEM_POSITION logs the redeem itself, using the display fields the popup passed in', async () => {
    vi.mocked(restoreWallet).mockResolvedValue(fakeWallet)
    vi.mocked(getSettings).mockResolvedValue({ workerUrl: 'https://w.invalid', workerSecret: 'sek' } as never)
    vi.mocked(fetchPositions).mockResolvedValue([])
    vi.mocked(redeemPosition).mockResolvedValue({ ok: true, transactionId: 'tx-1' })

    await handle({
      target: 'offscreen',
      type: 'OS_REDEEM_POSITION',
      conditionId: '0xcond',
      question: 'Resolved market',
      marketSlug: 'resolved-market',
      outcome: 'Yes',
      shares: 12,
    })

    expect(logTrade).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REDEEM', status: 'placed', question: 'Resolved market', marketSlug: 'resolved-market',
      outcome: 'Yes', shares: 12, ref: 'tx-1',
    }))
  })
})
