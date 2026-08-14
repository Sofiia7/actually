// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('./ops', () => ({
  orderbookSnapshotViaOffscreen: vi.fn(),
  sellOrderViaOffscreen: vi.fn(),
}))

import { SellTicket, humanSellError } from './SellTicket'
import * as ops from './ops'
import type { Position } from '../shared/types'

const opsm = ops as unknown as Record<string, ReturnType<typeof vi.fn>>

const position: Position = {
  tokenId: 'tok-yes',
  conditionId: 'cond-1',
  size: 142.86,
  avgPrice: 0.014,
  curPrice: 0.0179,
  currentValue: 2.56,
  cashPnl: -0.21,
  percentPnl: -10.7,
  outcome: 'Yes',
  title: 'US announces end of Iranian blockade by August 15, 2026?',
  slug: 'us-blockade',
  redeemable: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  opsm.orderbookSnapshotViaOffscreen.mockResolvedValue({
    bestBid: 0.5, bestAsk: 0.52, spread: 0.02, bids: [], asks: [], estimate: null,
  })
  opsm.sellOrderViaOffscreen.mockResolvedValue({ ok: true, orderId: '0xsell123456' })
})

const noop = () => {}

describe('SellTicket', () => {
  it('defaults to selling the whole position, truncated to what is really held', async () => {
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    const shares = (await screen.findByLabelText(/Shares to sell/i)) as HTMLInputElement
    // 142.86 exactly — never rounded UP past the held balance.
    expect(shares.value).toBe('142.86')
  })

  it('sells in SHARES, not dollars, and only after a confirm step', async () => {
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    await screen.findByLabelText(/Shares to sell/i)
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell now/i })).toBeEnabled())

    await userEvent.click(screen.getByRole('button', { name: /Sell now/i }))
    // Nothing submitted yet — the confirm line is the gate.
    expect(opsm.sellOrderViaOffscreen).not.toHaveBeenCalled()
    expect(screen.getByText(/Sell 142\.86 shares/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(opsm.sellOrderViaOffscreen).toHaveBeenCalledOnce())
    expect(opsm.sellOrderViaOffscreen.mock.calls[0][0]).toMatchObject({
      tokenId: 'tok-yes',
      sizeShares: 142.86,
      orderType: 'MARKET',
    })
  })

  it('floors a market sell below the bid rather than selling at any price', async () => {
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell now/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Sell now/i }))
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(opsm.sellOrderViaOffscreen).toHaveBeenCalledOnce())
    // 0.5 bid − 2% = 0.49; a sell must never fill below it.
    expect(opsm.sellOrderViaOffscreen.mock.calls[0][0].price).toBeCloseTo(0.49, 5)
  })

  it('blocks selling more shares than are held', async () => {
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    const shares = await screen.findByLabelText(/Shares to sell/i)
    fireEvent.change(shares, { target: { value: '500' } })
    expect(await screen.findByText(/You only hold 142\.86 shares/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sell now/i })).toBeDisabled()
  })

  it('blocks a sell under the 5-share CLOB minimum', async () => {
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    const shares = await screen.findByLabelText(/Shares to sell/i)
    fireEvent.change(shares, { target: { value: '3' } })
    expect(await screen.findByText(/Minimum sell is 5 shares/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sell now/i })).toBeDisabled()
  })

  it('says plainly when a whole position is too small to ever sell', async () => {
    render(<SellTicket position={{ ...position, size: 3 }} onDone={noop} onCancel={noop} />)
    expect(await screen.findByText(/under Polymarket's 5-share minimum/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sell now/i })).toBeDisabled()
  })

  it('refuses a market sell when nobody is bidding', async () => {
    opsm.orderbookSnapshotViaOffscreen.mockResolvedValue({
      bestBid: null, bestAsk: null, spread: null, bids: [], asks: [], estimate: null,
    })
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    expect(await screen.findByText(/No bids on the book/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sell now/i })).toBeDisabled()
  })

  it('surfaces a rejection instead of reporting a sale that did not happen', async () => {
    opsm.sellOrderViaOffscreen.mockResolvedValue({ ok: false, error: 'not enough balance / allowance' })
    render(<SellTicket position={position} onDone={noop} onCancel={noop} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell now/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Sell now/i }))
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    expect(await screen.findByText(/don't hold enough of this token/i)).toBeInTheDocument()
  })

  it('refreshes the portfolio only after a sell actually succeeded', async () => {
    const onDone = vi.fn()
    opsm.sellOrderViaOffscreen.mockResolvedValue({ ok: false, error: 'boom' })
    render(<SellTicket position={position} onDone={onDone} onCancel={noop} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell now/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Sell now/i }))
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(opsm.sellOrderViaOffscreen).toHaveBeenCalledOnce())
    expect(onDone).not.toHaveBeenCalled()
  })

  it('hands the confirmation UP rather than showing it and unmounting', async () => {
    // The ticket closes on success, so a message it owns dies with it — which
    // read as "the sell did nothing". The panel outlives the ticket.
    const onDone = vi.fn()
    render(<SellTicket position={position} onDone={onDone} onCancel={noop} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell now/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Sell now/i }))
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    const msg = onDone.mock.calls[0][0] as string
    expect(msg).toContain('Sell placed')
    expect(msg).toContain('0xsell1234')
    // …and it warns that the numbers lag, instead of leaving the user to
    // conclude the sale failed.
    expect(msg).toMatch(/few seconds/i)
  })

  it('says a limit sell is resting, not filled', async () => {
    const onDone = vi.fn()
    render(<SellTicket position={position} onDone={onDone} onCancel={noop} />)
    await screen.findByLabelText(/Shares to sell/i)
    await userEvent.click(screen.getByRole('button', { name: 'Limit' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Sell at limit/i })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: /Sell at limit/i }))
    await userEvent.click(screen.getByRole('button', { name: /Sign in wallet/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(onDone.mock.calls[0][0]).toMatch(/resting on the book/i)
  })
})

describe('humanSellError', () => {
  it('translates the reasons a sell actually gets rejected for', () => {
    expect(humanSellError('invalid order minimum size', 5)).toMatch(/5-share minimum/)
    expect(humanSellError('not enough balance / allowance', 5)).toMatch(/don't hold enough/)
    expect(humanSellError('FOK order not filled', 5)).toMatch(/book moved/)
    expect(humanSellError('invalid tick size', 5)).toMatch(/valid tick/)
    expect(humanSellError('no_wallet', 5)).toMatch(/reconnect/i)
  })

  it('passes an unrecognised reason through rather than hiding it', () => {
    expect(humanSellError('some_new_clob_code', 5)).toBe('some_new_clob_code')
  })
})
