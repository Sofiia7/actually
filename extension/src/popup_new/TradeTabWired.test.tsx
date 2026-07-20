// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

describe('TradeTabWired — match context (ТЗ §6.1)', () => {
  it('shows the article headline as context when provided', async () => {
    opsm.restoreWalletViaOffscreen.mockResolvedValue(null)
    render(<TradeTabWired {...props} articleHeadline="Iran enriches uranium to 60%" />)
    expect(await screen.findByText(/Iran enriches uranium/i)).toBeInTheDocument()
    expect(screen.getByText(/From this page/i)).toBeInTheDocument()
  })
})
