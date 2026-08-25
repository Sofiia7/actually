// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HistoryTab, type HistoryState, type TradeRow } from './HistoryTab'

const noop = () => {}

const stories: HistoryState = {
  kind: 'success',
  items: [
    { pct: 42, q: 'Will X happen?', src: 'reuters.com', when: '2h ago' },
    { pct: 68, q: 'Will Y happen?', src: 'bbc.com', when: '5h ago' },
  ],
}

const trades: TradeRow[] = [
  { kind: 'BUY', status: 'placed', q: 'Will X happen?', detail: '$2.00 · Yes @ 6.0¢ · limit', when: '1m ago' },
]

/**
 * A limit order that reached the exchange has not necessarily bought anything
 * - it can sit on the book unfilled for as long as the price stays away. The
 * log records "placed" for both cases, so calling every one of them "Bought"
 * tells the user they own something they may not own, with no hint that there
 * is an order out there still live and cancellable.
 */
describe('a resting limit order is not a purchase', () => {
  const limitBuy: TradeRow = {
    kind: 'BUY',
    status: 'placed',
    orderType: 'LIMIT',
    q: 'Will X happen?',
    detail: '$5.00 · No @ 91.0¢ · limit',
    when: '1h ago',
  }

  it('says the order was placed rather than filled', () => {
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={[limitBuy]} />)
    expect(screen.getByText(/Buy placed/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Bought$/i)).not.toBeInTheDocument()
  })

  it('says where to see whether it filled, and where to cancel it', () => {
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={[limitBuy]} />)
    const hint = screen.getByText(/rests on the book/i)
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).toMatch(/cancel/i)
  })

  it('keeps that hint out of the way when nothing is resting', () => {
    const marketBuy: TradeRow = { ...limitBuy, orderType: 'MARKET' }
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={[marketBuy]} />)
    expect(screen.queryByText(/rests on the book/i)).not.toBeInTheDocument()
  })

  it('still says Bought for a market order, which fills on the spot', () => {
    const marketBuy: TradeRow = { ...limitBuy, orderType: 'MARKET', detail: '$5.00 · No · market' }
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={[marketBuy]} />)
    expect(screen.getByText(/Bought/i)).toBeInTheDocument()
  })

  // The row is where the user is looking when they decide to cancel. Sending
  // them to another tab to find the same order in a different list is a
  // navigation puzzle, not an interface.
  it('offers to cancel the order right where the order is', async () => {
    const onCancel = vi.fn()
    render(
      <HistoryTab
        state={stories}
        onSelect={noop}
        onOpenArticle={noop}
        onClear={noop}
        trades={[{ ...limitBuy, onCancel }]}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /cancel order/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not offer to cancel something that already filled or failed', () => {
    const onCancel = vi.fn()
    render(
      <HistoryTab
        state={stories}
        onSelect={noop}
        onOpenArticle={noop}
        onClear={noop}
        trades={[{ ...limitBuy, orderType: 'MARKET', onCancel }]}
      />,
    )
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument()
  })

  it('stops offering to cancel an order that is already cancelled', () => {
    render(
      <HistoryTab
        state={stories}
        onSelect={noop}
        onOpenArticle={noop}
        onClear={noop}
        trades={[{ ...limitBuy, status: 'cancelled', onCancel: vi.fn() }]}
      />,
    )
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel order/i })).not.toBeInTheDocument()
  })

  it('says it is working while the cancel is in flight', () => {
    render(
      <HistoryTab
        state={stories}
        onSelect={noop}
        onOpenArticle={noop}
        onClear={noop}
        trades={[{ ...limitBuy, onCancel: vi.fn(), cancelling: true }]}
      />,
    )
    expect(screen.getByText(/cancelling/i)).toBeInTheDocument()
  })

  it('does not promise a fill that failed', () => {
    const failed: TradeRow = { ...limitBuy, status: 'failed', error: 'not enough balance' }
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={[failed]} />)
    expect(screen.queryByText(/Buy placed/i)).not.toBeInTheDocument()
  })
})

/**
 * The tab shows two different KINDS of record - things you did, and pages you
 * looked at - and used to leave the reader to work that out from the words
 * "Your trades" and "Recent matches" alone.
 */
describe('HistoryTab tells its two lists apart', () => {
  it('names each section for what it holds, not for what it is called internally', () => {
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={trades} />)
    expect(screen.getByText(/Buys, sells and redeems you made here/i)).toBeInTheDocument()
    expect(screen.getByText(/Pages you ran Check on/i)).toBeInTheDocument()
  })

  it('counts each list, so the split is readable without scrolling it', () => {
    render(<HistoryTab state={stories} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={trades} />)
    expect(screen.getByText(/Your trades \(1\)/i)).toBeInTheDocument()
    expect(screen.getByText(/Stories you checked \(2\)/i)).toBeInTheDocument()
  })

  it('regression: the bottom button says which list it clears', async () => {
    // It was labelled "Clear history" and wired to CLEAR_HISTORY, which wipes
    // the checked-stories list ONLY - trades survive it. Sitting under the
    // stories with a name that sounds global, it read as "erase everything on
    // this tab", which is the one thing it does not do.
    const onClear = vi.fn()
    const onClearTrades = vi.fn()
    render(
      <HistoryTab
        state={stories} onSelect={noop} onOpenArticle={noop}
        onClear={onClear} trades={trades} onClearTrades={onClearTrades}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Clear checked stories/i }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onClearTrades).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Clear history$/i })).not.toBeInTheDocument()
  })

  it('gives the trade list its own clear, scoped by name', async () => {
    const onClear = vi.fn()
    const onClearTrades = vi.fn()
    render(
      <HistoryTab
        state={stories} onSelect={noop} onOpenArticle={noop}
        onClear={onClear} trades={trades} onClearTrades={onClearTrades}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Clear trades/i }))
    expect(onClearTrades).toHaveBeenCalledOnce()
    expect(onClear).not.toHaveBeenCalled()
  })

  it('keeps showing trades when no story has been checked yet', () => {
    // The logs have different lifetimes (100 trades vs 10 stories), so an
    // empty story list must not hide a trade the user came looking for.
    render(<HistoryTab state={{ kind: 'empty' }} onSelect={noop} onOpenArticle={noop} onClear={noop} trades={trades} />)
    expect(screen.getByText(/Your trades \(1\)/i)).toBeInTheDocument()
    expect(screen.getByText(/No checked stories yet/i)).toBeInTheDocument()
  })
})
