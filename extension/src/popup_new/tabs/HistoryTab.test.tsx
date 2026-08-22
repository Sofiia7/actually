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
 * The tab shows two different KINDS of record — things you did, and pages you
 * looked at — and used to leave the reader to work that out from the words
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
    // the checked-stories list ONLY — trades survive it. Sitting under the
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
