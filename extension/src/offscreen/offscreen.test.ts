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
vi.mock('../background/cache', () => ({
  getMarketCache: vi.fn(),
  refreshMarketCache: vi.fn(),
  getCacheStatus: vi.fn(),
}))
vi.mock('../background/adapters', () => ({
  makeChromeMarketStore: vi.fn(),
  makeSettingsEmbedder: vi.fn(),
}))
vi.mock('../background/history', () => ({ addToHistory: vi.fn() }))
vi.mock('../background/telemetry', () => ({ trackEvent: vi.fn() }))

import { handle } from './offscreen'
import { placeOrder, restoreWallet, sellOrder } from '../background/trade'
import { redeemPosition } from '../background/redeem'
import { fetchPositions } from '../background/positions'
import { getSettings } from '../background/settings'
import { logTrade } from '../background/tradeLog'
import { getMarketCache, refreshMarketCache, getCacheStatus } from '../background/cache'
import { makeChromeMarketStore, makeSettingsEmbedder } from '../background/adapters'

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

  // 2026-09-08 audit F03: an order the exchange never answered for is logged
  // as unconfirmed, with its token, because that row is what holds back a
  // second order on the same token until the exchange has been checked.
  it('OS_PLACE_ORDER logs an unanswered order as unknown, with its token, and passes the flag to the popup', async () => {
    vi.mocked(restoreWallet).mockResolvedValue(fakeWallet)
    vi.mocked(placeOrder).mockResolvedValue({ ok: false, unknown: true, error: 'order_status_unknown:Network Error' })

    const res = await handle({
      target: 'offscreen',
      type: 'OS_PLACE_ORDER',
      args: {
        tokenId: 'tok-yes', side: 'BUY_YES', sizeUsd: 20, price: 0.25, negRisk: false,
        orderType: 'MARKET', question: 'Will it happen?', marketSlug: 'will-it-happen', outcome: 'Yes',
      },
    })

    expect(logTrade).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'BUY', status: 'unknown', tokenId: 'tok-yes', error: 'order_status_unknown:Network Error',
    }))
    expect(res).toMatchObject({ type: 'OS_ORDER_RESULT', ok: false, unknown: true })
  })

  it('OS_SELL_ORDER does the same for a sell, and records the token on a settled one too', async () => {
    vi.mocked(restoreWallet).mockResolvedValue(fakeWallet)
    vi.mocked(sellOrder).mockResolvedValue({ ok: false, unknown: true, error: 'order_status_unknown:Bad Gateway' })
    await handle({
      target: 'offscreen',
      type: 'OS_SELL_ORDER',
      args: { tokenId: 'tok-no', sizeShares: 40, price: 0.3, orderType: 'LIMIT', question: 'Q', outcome: 'No' },
    })
    expect(logTrade).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SELL', status: 'unknown', tokenId: 'tok-no' }))

    vi.mocked(sellOrder).mockResolvedValue({ ok: true, orderId: 'order-2' })
    await handle({
      target: 'offscreen',
      type: 'OS_SELL_ORDER',
      args: { tokenId: 'tok-no', sizeShares: 40, price: 0.3, orderType: 'LIMIT', question: 'Q', outcome: 'No' },
    })
    expect(logTrade).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'placed', tokenId: 'tok-no' }))
  })
})

describe('offscreen handle() - a stale cache refreshes even when matching fails (2026-09-08 audit F14)', () => {
  const settings = {
    confidenceThreshold: 0.5, lowConfidenceFloor: 0.35, embeddingProvider: 'local' as const,
    workerUrl: 'https://w.invalid', workerSecret: 'sek', telemetryEnabled: false,
    searchFallbackEnabled: false, searchFallbackOfferDismissed: false,
  }
  const staleMarket = {
    id: 'm1', slug: 'm1', question: 'Will X?', outcomePrices: '["0.5","0.5"]', outcomes: '["Yes","No"]',
    volume: 0, liquidity: 0, active: true, closed: false, clobTokenIds: ['a', 'b'],
    embeddingB64: 'AAAA', questionHash: 'h', cachedAt: 1,
  }

  it('triggers a background cache refresh on a NO-MATCH result, not only after a successful one', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings as never)
    // Non-empty so the "cache is empty, refresh now" branch is not what
    // triggers the refresh this test is actually checking for.
    vi.mocked(getMarketCache).mockResolvedValue([staleMarket] as never)
    // Old enough that maybeRefreshStale's own TTL check decides to refresh.
    vi.mocked(getCacheStatus).mockResolvedValue({ count: 1, lastUpdated: Date.now() - 60 * 60_000, builtAt: Date.now() - 60 * 60_000 })
    vi.mocked(refreshMarketCache).mockResolvedValue({ added: 0, reused: 0, removed: 0 })
    // Empty store so attemptMatch cleanly finds nothing, independent of
    // whatever getMarketCache reports above.
    vi.mocked(makeChromeMarketStore).mockReturnValue({ getMarkets: async () => [] })
    vi.mocked(makeSettingsEmbedder).mockReturnValue({ embed: async () => new Float32Array([1, 0]) })

    const result = await handle({
      target: 'offscreen', type: 'OS_RUN_MATCH',
      article: { headline: 'Some headline', bodyText: '', url: 'https://news.example/a', domain: 'news.example' },
    })

    expect(result).toMatchObject({ type: 'OS_MATCH_RESULT', match: null })
    // maybeRefreshStale is fire-and-forget - give its microtask a turn.
    await new Promise((r) => setTimeout(r, 0))
    expect(refreshMarketCache).toHaveBeenCalled()
  })

  it('does not retry immediately after a failed refresh - one dead network must not mean one refresh attempt per check', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings as never)
    vi.mocked(getMarketCache).mockResolvedValue([staleMarket] as never)
    vi.mocked(getCacheStatus).mockResolvedValue({ count: 1, lastUpdated: Date.now() - 60 * 60_000, builtAt: Date.now() - 60 * 60_000 })
    vi.mocked(refreshMarketCache).mockRejectedValue(new Error('network down'))
    vi.mocked(makeChromeMarketStore).mockReturnValue({ getMarkets: async () => [] })
    vi.mocked(makeSettingsEmbedder).mockReturnValue({ embed: async () => new Float32Array([1, 0]) })

    const article = { headline: 'Some headline', bodyText: '', url: 'https://news.example/a', domain: 'news.example' }
    await handle({ target: 'offscreen', type: 'OS_RUN_MATCH', article })
    await new Promise((r) => setTimeout(r, 0)) // let the failed attempt settle
    await handle({ target: 'offscreen', type: 'OS_RUN_MATCH', article })
    await new Promise((r) => setTimeout(r, 0))

    expect(refreshMarketCache).toHaveBeenCalledTimes(1)
  })
})

describe('offscreen handle() - one refresh coordinator, not three separate guards (2026-09-08 audit F18)', () => {
  const settings = {
    confidenceThreshold: 0.5, lowConfidenceFloor: 0.35, embeddingProvider: 'local' as const,
    workerUrl: 'https://w.invalid', workerSecret: 'sek', telemetryEnabled: false,
    searchFallbackEnabled: false, searchFallbackOfferDismissed: false,
  }

  it('a concurrent OS_REFRESH_CACHE and OS_RUN_MATCH bootstrap share one refresh instead of running two', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings as never)
    // Empty cache - OS_RUN_MATCH's own bootstrap branch (previously
    // ungated entirely) wants to refresh too.
    vi.mocked(getMarketCache).mockResolvedValue([] as never)
    vi.mocked(getCacheStatus).mockResolvedValue({ count: 0, lastUpdated: 0, builtAt: 0 })
    let resolveRefresh: ((v: { added: number; reused: number; removed: number }) => void) | undefined
    vi.mocked(refreshMarketCache).mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve }))
    vi.mocked(makeChromeMarketStore).mockReturnValue({ getMarkets: async () => [] })
    vi.mocked(makeSettingsEmbedder).mockReturnValue({ embed: async () => new Float32Array([1, 0]) })

    const article = { headline: 'Some headline', bodyText: '', url: 'https://news.example/a', domain: 'news.example' }
    const p1 = handle({ target: 'offscreen', type: 'OS_REFRESH_CACHE' })
    const p2 = handle({ target: 'offscreen', type: 'OS_RUN_MATCH', article })
    // Both calls have now synchronously reached (or awaited into) the
    // refresh call - only then does the single shared attempt resolve.
    await new Promise((r) => setTimeout(r, 0))
    expect(refreshMarketCache).toHaveBeenCalledTimes(1)
    resolveRefresh!({ added: 0, reused: 0, removed: 0 })
    await Promise.all([p1, p2])
  })
})
