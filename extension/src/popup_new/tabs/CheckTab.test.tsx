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
})
