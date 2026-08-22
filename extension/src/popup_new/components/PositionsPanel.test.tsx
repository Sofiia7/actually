// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { humanRedeemError, PositionsPanel } from './PositionsPanel'
import * as ops from '../ops'
import type { Position } from '../../shared/types'

const opsm = ops as unknown as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  opsm.builderStatusViaOffscreen.mockResolvedValue(false)
})

vi.mock('../ops', () => ({
  redeemPositionViaOffscreen: vi.fn(),
  builderStatusViaOffscreen: vi.fn(async () => false),
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
    expect(msg).toMatch(/unauthorized \(401\)/i)
    expect(msg).toMatch(/on Polymarket/i)
    // And it must say the money is not at risk.
    expect(msg).toMatch(/safe/i)
    expect(msg).not.toContain('statusText')
    // It must NOT blame a missing builder credential. That claim was wrong
    // for weeks — the credential was configured and signing 200s, while a
    // missing CORS header kept the browser from ever fetching a signature.
    // A message that diagnoses beyond its evidence sends people to fix the
    // wrong thing.
    expect(msg).not.toMatch(/builder API key/i)
  })

  it('distinguishes an unconfirmed redeem from a failed one', () => {
    expect(humanRedeemError('redeem_status_unknown:poll_timeout')).toMatch(/couldn't be confirmed/i)
    expect(humanRedeemError('relayer_state:STATE_FAILED')).toMatch(/failed on-chain/i)
  })

  it('keeps an unrecognised reason visible rather than hiding it', () => {
    expect(humanRedeemError('some_new_relayer_code')).toBe('some_new_relayer_code')
  })
})


describe('the position row', () => {
  it('spells out the cost basis so a wrong entry price is visible without arithmetic', () => {
    // Sofia's live case: a $2 buy of 153.84 shares briefly reported "@ 6.0¢"
    // with "-$7.38 (-80.0%)". Every number agreed with every other, so the
    // only way to notice was to work out that -80% implied a $9.23 basis.
    const position: Position = {
      ...resolved,
      redeemable: false,
      size: 153.84,
      avgPrice: 0.06,
      curPrice: 0.012,
      currentValue: 1.85,
      cashPnl: -7.38,
      percentPnl: -80,
    }
    render(
      <PositionsPanel positions={[position]} openOrders={[]} loading={false}
        cancellingId={null} onCancelOrder={() => {}} onRefresh={() => {}} />,
    )
    expect(screen.getByText(/153\.84 shares @ 6\.0¢ \(\$9\.23\)/)).toBeInTheDocument()
  })

  it('agrees with itself on a healthy position', () => {
    const position: Position = {
      ...resolved,
      redeemable: false,
      size: 153.84,
      avgPrice: 0.013,
      curPrice: 0.012,
      currentValue: 1.85,
      cashPnl: -0.15,
      percentPnl: -7.7,
    }
    render(
      <PositionsPanel positions={[position]} openOrders={[]} loading={false}
        cancellingId={null} onCancelOrder={() => {}} onRefresh={() => {}} />,
    )
    expect(screen.getByText(/153\.84 shares @ 1\.3¢ \(\$2\.00\)/)).toBeInTheDocument()
  })
})

describe('a resolved position', () => {
  it('sends the user to Polymarket when the Worker has no builder credentials', async () => {
    // The relayer SDK signs BEFORE it submits, and that submit 401s without
    // builder credentials — so an in-app "Redeem →" would cost a wallet
    // prompt and fail every time.
    opsm.builderStatusViaOffscreen.mockResolvedValue(false)
    render(
      <PositionsPanel positions={[resolved]} openOrders={[]} loading={false}
        cancellingId={null} onCancelOrder={() => {}} onRefresh={() => {}} />,
    )
    expect(await screen.findByText(/Claim on Polymarket/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Redeem →$/)).not.toBeInTheDocument()
    // A resolved market must never offer Sell — the CLOB would only reject it.
    expect(screen.queryByText(/Sell →/)).not.toBeInTheDocument()
  })

  it('offers in-app redeem as soon as the Worker reports credentials, with no rebuild', async () => {
    opsm.builderStatusViaOffscreen.mockResolvedValue(true)
    render(
      <PositionsPanel positions={[resolved]} openOrders={[]} loading={false}
        cancellingId={null} onCancelOrder={() => {}} onRefresh={() => {}} />,
    )
    expect(await screen.findByText(/Redeem →/)).toBeInTheDocument()
  })

  it('does not ask the Worker anything when nothing is redeemable', () => {
    render(
      <PositionsPanel positions={[{ ...resolved, redeemable: false }]} openOrders={[]} loading={false}
        cancellingId={null} onCancelOrder={() => {}} onRefresh={() => {}} />,
    )
    expect(opsm.builderStatusViaOffscreen).not.toHaveBeenCalled()
  })
})
