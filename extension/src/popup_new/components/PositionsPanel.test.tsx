// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { humanRedeemError, PositionsPanel } from './PositionsPanel'
import { IN_APP_REDEEM_ENABLED } from '../../shared/constants'
import type { Position } from '../../shared/types'

vi.mock('../ops', () => ({
  redeemPositionViaOffscreen: vi.fn(),
  orderbookSnapshotViaOffscreen: vi.fn(async () => ({ bestBid: null, bestAsk: null, spread: null, bids: [], asks: [], estimate: null })),
  sellOrderViaOffscreen: vi.fn(),
}))

const resolved: Position = {
  tokenId: 'tok', conditionId: 'cond-1', size: 129.17, avgPrice: 0.015, curPrice: 1,
  currentValue: 129.17, cashPnl: 127, percentPnl: 6000, outcome: 'Yes',
  title: 'Will Google have the best AI model at the end of July 2026?',
  slug: 'google-ai', redeemable: true, outcomeIndex: 0, negativeRisk: false,
}

describe('humanRedeemError — say what happened and what to do next', () => {
  it('explains the relayer 401 instead of dumping its JSON', () => {
    // What the live relayer actually returns for an unauthenticated
    // POST /submit — the exact blob a user saw in the popup on 2026-08-16.
    const raw = '{"error":"request error","status":401,"statusText":"","data":{"error":"invalid authorization"}}'
    const msg = humanRedeemError(raw)
    expect(msg).toMatch(/builder API key/i)
    expect(msg).toMatch(/on Polymarket/i)
    // And it must say the money is not at risk.
    expect(msg).toMatch(/safe/i)
    expect(msg).not.toContain('statusText')
  })

  it('distinguishes an unconfirmed redeem from a failed one', () => {
    expect(humanRedeemError('redeem_status_unknown:poll_timeout')).toMatch(/couldn't be confirmed/i)
    expect(humanRedeemError('relayer_state:STATE_FAILED')).toMatch(/failed on-chain/i)
  })

  it('keeps an unrecognised reason visible rather than hiding it', () => {
    expect(humanRedeemError('some_new_relayer_code')).toBe('some_new_relayer_code')
  })
})


describe('a resolved position, while in-app redeem is unavailable', () => {
  it('sends the user to Polymarket instead of asking for a doomed wallet signature', () => {
    // The relayer SDK signs BEFORE it submits, and the submit 401s without
    // builder credentials — so an in-app "Redeem →" costs a wallet prompt
    // and fails every time. Guard the flag so this test starts failing (and
    // gets rewritten) the day credentials land.
    expect(IN_APP_REDEEM_ENABLED).toBe(false)
    render(
      <PositionsPanel
        positions={[resolved]}
        openOrders={[]}
        loading={false}
        cancellingId={null}
        onCancelOrder={() => {}}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText(/Claim on Polymarket/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Redeem →$/)).not.toBeInTheDocument()
    // And a resolved market must never offer Sell — it would only ever be
    // rejected by the CLOB.
    expect(screen.queryByText(/Sell →/)).not.toBeInTheDocument()
  })
})
