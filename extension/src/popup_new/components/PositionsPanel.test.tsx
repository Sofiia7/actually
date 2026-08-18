// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { humanRedeemError } from './PositionsPanel'

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
