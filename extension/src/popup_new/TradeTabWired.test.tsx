// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the offscreen RPC layer used by TradeTabWired AND trade/Analytics.
vi.mock('./ops', () => ({
  restoreWalletViaOffscreen: vi.fn(),
  getGeoViaOffscreen: vi.fn(),
  orderbookSnapshotViaOffscreen: vi.fn(),
  priceHistoryViaOffscreen: vi.fn(),
  placeOrderViaOffscreen: vi.fn(),
  disconnectWalletViaOffscreen: vi.fn(),
  startConnectViaOffscreen: vi.fn(),
  pollConnectViaOffscreen: vi.fn(),
  cancelOrderViaOffscreen: vi.fn(),
  getPositionsViaOffscreen: vi.fn(async () => ({ ok: true, positions: [] })),
  getOpenOrdersViaOffscreen: vi.fn(async () => ({ ok: true, orders: [] })),
}))

import { TradeTabWired } from './TradeTabWired'
import * as ops from './ops'
import type { Settings } from '../shared/types'
import type { MatchResult, PolyMarket } from '@actually/core'

const market: PolyMarket = {
  id: 'm1',
  slug: 'will-x',
  question: 'Will X happen?',
  outcomePrices: '["0.42","0.58"]',
  outcomes: '["Yes","No"]',
  volume: 1_200_000,
  liquidity: 340_000,
  active: true,
  closed: false,
  clobTokenIds: ['yesTok', 'noTok'],
  negRisk: false,
  tickSize: '0.01',
  endDate: '2026-12-31',
  description: 'Resolves YES if X.',
  resolutionSource: 'Oracle',
}

const match: MatchResult = {
  market,
  probability: 0.42,
  confidence: 0.8,
  color: 'yellow',
  lowConfidence: false,
  alternatives: [],
  alternativeScores: [],
}

const settings: Settings = {
  confidenceThreshold: 0.45,
  lowConfidenceFloor: 0.3,
  embeddingProvider: 'local',
  workerUrl: 'https://w',
  workerSecret: 's',
  telemetryEnabled: false,
}

const wallet = {
  topic: 't',
  address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca',
  safeAddress: '0xsafesafesafesafesafesafesafesafesafesafe',
  creds: { key: 'k', secret: 's', passphrase: 'p' },
}

const props = {
  match,
  settings,
  onPickMatch: () => {},
  onOpenSettings: () => {},
  onMatchOpenedExternally: () => {},
}

const opsm = ops as unknown as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  opsm.getGeoViaOffscreen.mockResolvedValue({ country: 'RS', blocked: false, unknown: false })
  opsm.priceHistoryViaOffscreen.mockResolvedValue([])
  opsm.orderbookSnapshotViaOffscreen.mockResolvedValue({ bestBid: 0.4, bestAsk: 0.42, spread: 0.02, bids: [], asks: [], estimate: null })
  opsm.placeOrderViaOffscreen.mockResolvedValue({ ok: true, orderId: '0x123' })
})

describe('TradeTabWired — wallet gating', () => {
  it('without a wallet: shows Connect and hides analytics', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(null)
    render(<TradeTabWired {...props} />)
    expect(await screen.findByText(/Connect wallet/i)).toBeInTheDocument()
    // Analytics are wallet-gated — must NOT render in the no-wallet state.
    expect(screen.queryByText('Orderbook')).toBeNull()
    expect(screen.queryByText(/7-day trend/i)).toBeNull()
  })

  it('with a wallet: shows analytics + the order ticket', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    render(<TradeTabWired {...props} />)
    expect(await screen.findByText('Orderbook')).toBeInTheDocument()
    expect(screen.getByText('Limit')).toBeInTheDocument()
    expect(screen.getByText('Market')).toBeInTheDocument()
    expect(screen.getByText('BUY YES')).toBeInTheDocument()
  })
})

describe('TradeTabWired — order ticket', () => {
  it('toggles between Limit and Market', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    expect(screen.getByText(/Limit price \(per share/i)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Market'))
    expect(screen.getByText(/fills now, capped/i)).toBeInTheDocument()
  })

  it('disables submit when a market order would exceed 20% slippage', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    opsm.orderbookSnapshotViaOffscreen.mockResolvedValue({
      bestBid: 0.4,
      bestAsk: 0.42,
      spread: 0.02,
      bids: [],
      asks: [],
      estimate: { effectivePrice: 0.55, slippage: 0.25 },
    })
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    await userEvent.click(screen.getByText('Market'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Place market order/i })).toBeDisabled()
    })
  })

  it('a rapid double-click on "Sign in wallet" only submits one order (re-entrancy guard)', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    let resolvePlace: ((v: { ok: boolean; orderId: string }) => void) | undefined
    opsm.placeOrderViaOffscreen.mockImplementation(
      () => new Promise((resolve) => { resolvePlace = resolve }),
    )
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    await waitFor(() => expect(screen.getByRole('button', { name: /Place limit order/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Place limit order/i }))
    const signButton = screen.getByRole('button', { name: /Sign in wallet/i })
    // Two synchronous click events, no await between them — the worst-case
    // race a real fast double-click/double-tap can produce, before React
    // has any chance to re-render the button as disabled.
    fireEvent.click(signButton)
    fireEvent.click(signButton)
    resolvePlace!({ ok: true, orderId: '0xabc123' })
    await waitFor(() => expect(opsm.placeOrderViaOffscreen).toHaveBeenCalledTimes(1))
  })

  it('requires a confirm step before signing (ТЗ §6.5)', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    // Limit price prefills from best ask; wait until the primary button enables.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Place limit order/i })).toBeEnabled()
    })
    await userEvent.click(screen.getByRole('button', { name: /Place limit order/i }))
    // Confirm card shows; the order is NOT placed yet.
    expect(screen.getByText(/Confirm limit order/i)).toBeInTheDocument()
    expect(opsm.placeOrderViaOffscreen).not.toHaveBeenCalled()
    // Only after "Sign in wallet" does the order go through.
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(opsm.placeOrderViaOffscreen).toHaveBeenCalledOnce())
  })
})

describe('TradeTabWired — connect loop race', () => {
  it('a stale connect loop (after Cancel + reconnect) does not clobber the newer attempt\'s state', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(null)
    opsm.getPositionsViaOffscreen.mockResolvedValue({ ok: true, positions: [] })
    opsm.getOpenOrdersViaOffscreen.mockResolvedValue({ ok: true, orders: [] })

    const sessionIds = ['s1', 's2']
    let startCalls = 0
    opsm.startConnectViaOffscreen.mockImplementation(async () => sessionIds[startCalls++])

    // Session s1 (the one the user cancels) stays pending until the test
    // explicitly resolves it — modeling it still being in flight when the
    // user cancels and starts a fresh connect attempt.
    let resolveStaleS1Poll: ((v: { stage: string; error?: string }) => void) | undefined
    const staleS1PollPromise = new Promise<{ stage: string; error?: string }>((resolve) => {
      resolveStaleS1Poll = resolve
    })
    opsm.pollConnectViaOffscreen.mockImplementation(async (sessionId: string) => {
      if (sessionId === 's1') return staleS1PollPromise
      return { stage: 'done', wallet }
    })

    render(<TradeTabWired {...props} />)
    await userEvent.click(await screen.findByText(/Connect wallet/i))
    await screen.findByText(/preparing…/i) // s1's loop is now blocked awaiting the poll

    await userEvent.click(screen.getByText('Cancel'))
    await userEvent.click(await screen.findByText(/Connect wallet/i)) // starts s2 — a new generation

    // s2 resolves immediately to 'done' — the wallet should connect.
    await screen.findByText('Orderbook')

    // NOW let the orphaned s1 loop finally resolve with an error. Without
    // the generation guard this would overwrite the connected state with an
    // error banner from a session the user already abandoned.
    resolveStaleS1Poll!({ stage: 'error', error: 'stale_session_error' })
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.queryByText(/stale_session_error/i)).toBeNull()
    expect(screen.getByText('Orderbook')).toBeInTheDocument()
  })
})

describe('TradeTabWired — portfolio refresh race', () => {
  it('a slow cancel-triggered refresh does not clobber a faster concurrent manual Refresh', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    const openOrder = {
      orderId: 'o1',
      marketId: 'm1',
      tokenId: 'yesTok',
      side: 'BUY' as const,
      price: '0.5',
      originalSize: '10',
      sizeMatched: '0',
      status: 'live',
      outcome: 'Yes',
    }
    opsm.getPositionsViaOffscreen.mockResolvedValue({ ok: true, positions: [] })

    // Call 1 (initial mount refresh): resolves immediately with the order present.
    opsm.getOpenOrdersViaOffscreen.mockResolvedValueOnce({ ok: true, orders: [openOrder] })
    // Call 2 (triggered by Cancel's `finally` block): stays pending until
    // explicitly resolved — models eventual-consistency lag where the
    // CLOB/data-api hasn't indexed the cancellation yet, so it still
    // reports the order as open.
    let resolveStaleRefresh: ((v: { ok: boolean; orders: unknown[] }) => void) | undefined
    opsm.getOpenOrdersViaOffscreen.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStaleRefresh = resolve }),
    )
    // Call 3 (a manual "Refresh" click fired while call 2 is still
    // in-flight): resolves immediately, correctly reflecting the order gone.
    opsm.getOpenOrdersViaOffscreen.mockResolvedValueOnce({ ok: true, orders: [] })

    opsm.cancelOrderViaOffscreen.mockResolvedValue({ ok: true })

    render(<TradeTabWired {...props} />)
    const cancelLink = await screen.findByText('Cancel')
    await userEvent.click(cancelLink) // resolves fast, then kicks off call 2 (pending)

    // Manual refresh while call 2 is still in flight — resolves faster (call 3).
    const refreshLink = await screen.findByText(/^Refresh/i)
    await userEvent.click(refreshLink)
    await waitFor(() => expect(screen.getByText(/No open positions or resting orders/i)).toBeInTheDocument())

    // NOW let the stale call 2 finally resolve with the outdated "still open" order.
    resolveStaleRefresh!({ ok: true, orders: [openOrder] })
    await new Promise((r) => setTimeout(r, 20))

    // Without the generation guard, this stale response would overwrite the
    // fresher "no orders" state and resurrect the just-cancelled order.
    expect(screen.getByText(/No open positions or resting orders/i)).toBeInTheDocument()
    expect(screen.queryByText('Cancel')).toBeNull()
  })
})

describe('TradeTabWired — portfolio & cancel errors', () => {
  it('shows a "couldn\'t refresh" error instead of silently rendering an empty portfolio', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    opsm.getPositionsViaOffscreen.mockResolvedValue({ ok: false, error: 'rate_limited' })
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    expect(await screen.findByText(/Couldn't refresh: rate_limited/i)).toBeInTheDocument()
    expect(screen.queryByText(/No open positions or resting orders/i)).toBeNull()
  })

  it('surfaces a rejected cancel instead of discarding the result', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    // Explicit, since mockClear() in beforeEach doesn't reset a prior test's
    // mockResolvedValue — this test needs a successful positions fetch so
    // the portfolio error banner from the previous test doesn't leak in.
    opsm.getPositionsViaOffscreen.mockResolvedValue({ ok: true, positions: [] })
    opsm.getOpenOrdersViaOffscreen.mockResolvedValue({
      ok: true,
      orders: [
        {
          orderId: 'o1',
          marketId: 'm1',
          tokenId: 'yesTok',
          side: 'BUY',
          price: '0.5',
          originalSize: '10',
          sizeMatched: '0',
          status: 'live',
          outcome: 'Yes',
        },
      ],
    })
    opsm.cancelOrderViaOffscreen.mockResolvedValue({ ok: false, error: 'cancel_rejected' })
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    const cancelLink = await screen.findByText('Cancel')
    await userEvent.click(cancelLink)
    expect(await screen.findByText(/Cancel failed: cancel_rejected/i)).toBeInTheDocument()
  })
})

describe('TradeTabWired — cancel double-click race', () => {
  it('a rapid double-click on "Cancel" only issues one cancel request (re-entrancy guard)', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(wallet)
    opsm.getPositionsViaOffscreen.mockResolvedValue({ ok: true, positions: [] })
    opsm.getOpenOrdersViaOffscreen.mockResolvedValue({
      ok: true,
      orders: [
        { orderId: 'o1', marketId: 'm1', tokenId: 'yesTok', side: 'BUY', price: '0.5', originalSize: '10', sizeMatched: '0', status: 'live', outcome: 'Yes' },
      ],
    })
    let resolveCancel: ((v: { ok: boolean }) => void) | undefined
    opsm.cancelOrderViaOffscreen.mockImplementation(() => new Promise((resolve) => { resolveCancel = resolve }))
    render(<TradeTabWired {...props} />)
    await screen.findByText('Orderbook')
    const cancelLink = await screen.findByText('Cancel')
    fireEvent.click(cancelLink)
    fireEvent.click(cancelLink)
    resolveCancel!({ ok: true })
    await waitFor(() => expect(opsm.cancelOrderViaOffscreen).toHaveBeenCalledTimes(1))
  })
})

describe('TradeTabWired — match context (ТЗ §6.1)', () => {
  it('shows the article headline as context when provided', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(null)
    render(<TradeTabWired {...props} articleHeadline="Iran enriches uranium to 60%" />)
    expect(await screen.findByText(/Iran enriches uranium/i)).toBeInTheDocument()
    expect(screen.getByText(/From this page/i)).toBeInTheDocument()
  })
})
