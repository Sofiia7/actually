// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckTab, type CheckState } from './CheckTab'

const featured = { q: 'Will X happen?', pct: 42, vol: '$1.2M', match: 88, market: 'Polymarket' }
const success: CheckState = { kind: 'success', featured, related: [] }

const noop = () => {}

describe('CheckTab link wiring (regression for Sprint 2 dead links)', () => {
  it('calls onOpenMarket when "View on Polymarket →" is clicked', async () => {
    const onOpenMarket = vi.fn()
    render(
      <CheckTab state={success} onStart={noop} onBack={noop} onOpenMarket={onOpenMarket} onTrade={noop} />,
    )
    await userEvent.click(screen.getByText(/View on Polymarket/i))
    expect(onOpenMarket).toHaveBeenCalledOnce()
  })

  it('calls onTrade when "Trade this market →" is clicked', async () => {
    const onTrade = vi.fn()
    render(
      <CheckTab state={success} onStart={noop} onBack={noop} onOpenMarket={noop} onTrade={onTrade} />,
    )
    await userEvent.click(screen.getByText(/Trade this market/i))
    expect(onTrade).toHaveBeenCalledOnce()
  })

  it('does not render the "View on" link when no market name is provided', () => {
    const state: CheckState = { kind: 'success', featured: { ...featured, market: undefined }, related: [] }
    render(<CheckTab state={state} onStart={noop} onBack={noop} onOpenMarket={noop} onTrade={noop} />)
    expect(screen.queryByText(/View on/i)).toBeNull()
  })

  it('calls onStart from the idle state', async () => {
    const onStart = vi.fn()
    render(<CheckTab state={{ kind: 'idle' }} onStart={onStart} onBack={noop} />)
    await userEvent.click(screen.getByText(/Check this page/i))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('calls onPickRelated with the row index when an alternate is clicked (ТЗ §6.1)', async () => {
    const onPickRelated = vi.fn()
    const withRelated: CheckState = {
      kind: 'success',
      featured,
      related: [
        { q: 'Alt market A', pct: 30 },
        { q: 'Alt market B', pct: 70 },
      ],
    }
    render(
      <CheckTab state={withRelated} onStart={noop} onBack={noop} onPickRelated={onPickRelated} />,
    )
    await userEvent.click(screen.getByText('Alt market B'))
    expect(onPickRelated).toHaveBeenCalledWith(1)
  })
})

describe('the no-match screen offers the long-tail search where it matters', () => {
  const miss: CheckState = {
    kind: 'error',
    message: 'No open market lines up with this story.',
    detail: 'Closest of 1665 open markets was “Will the Lakers win?”, and not close.',
    searchUrl: 'https://polymarket.com/search?q=trump',
  }

  it('surfaces the offer on a miss, since Settings is where nobody looks', async () => {
    const onEnableSearch = vi.fn()
    render(
      <CheckTab
        state={{ ...miss, offerSearch: true }}
        onStart={noop} onBack={noop} onEnableSearch={onEnableSearch}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Search Polymarket too/i }))
    expect(onEnableSearch).toHaveBeenCalledOnce()
  })

  it('says what turning it on sends, in the same breath as the button', () => {
    // The click IS the consent, so the cost has to be legible at the click -
    // not buried in a privacy policy the user is not reading right now.
    render(<CheckTab state={{ ...miss, offerSearch: true }} onStart={noop} onBack={noop} onEnableSearch={noop} />)
    expect(screen.getByText(/six words from the headline/i)).toBeInTheDocument()
    expect(screen.getByText(/Switch it off any time in Settings/i)).toBeInTheDocument()
  })

  it('shows the offer INSTEAD of the outbound link, not alongside it', () => {
    render(<CheckTab state={{ ...miss, offerSearch: true }} onStart={noop} onBack={noop} onEnableSearch={noop} />)
    expect(screen.queryByText(/^Search Polymarket →$/)).not.toBeInTheDocument()
  })

  it('falls back to the plain outbound link once the offer no longer applies', () => {
    // Either the user already enabled search, or they declined the offer.
    render(<CheckTab state={miss} onStart={noop} onBack={noop} onEnableSearch={noop} />)
    expect(screen.getByText(/Search Polymarket →/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Search Polymarket too/i })).not.toBeInTheDocument()
  })

  it('lets the user decline - an offer that reappears forever is a nag', async () => {
    const onDismissSearchOffer = vi.fn()
    render(
      <CheckTab
        state={{ ...miss, offerSearch: true }}
        onStart={noop} onBack={noop} onEnableSearch={noop} onDismissSearchOffer={onDismissSearchOffer}
      />,
    )
    await userEvent.click(screen.getByText(/No thanks/i))
    expect(onDismissSearchOffer).toHaveBeenCalledOnce()
  })

  it('never offers on failures the search cannot fix', () => {
    // "Couldn't read the article" is not a coverage problem, and pitching a
    // privacy trade against it would be noise at best.
    render(
      <CheckTab
        state={{ kind: 'error', message: "Couldn't read the article on this page." }}
        onStart={noop} onBack={noop} onEnableSearch={noop}
      />,
    )
    expect(screen.queryByRole('button', { name: /Search Polymarket too/i })).not.toBeInTheDocument()
  })
})
