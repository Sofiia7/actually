import { describe, expect, it } from 'vitest'
import { resolveOrderToken } from './orderTarget'
import type { PolyMarket } from './types'

function market(over: Partial<PolyMarket> = {}): PolyMarket {
  return {
    id: 'm1',
    slug: 'will-x-happen',
    question: 'Will X happen?',
    outcomePrices: '["0.3","0.7"]',
    outcomes: '["Yes","No"]',
    volume: 100,
    liquidity: 50,
    active: true,
    closed: false,
    clobTokenIds: ['tok-yes', 'tok-no'],
    negRisk: false,
    tickSize: '0.01',
    ...over,
  }
}

describe('resolveOrderToken', () => {
  it('resolves Yes to the Yes-outcome token, never letting the caller pick the token directly', () => {
    const result = resolveOrderToken(market(), 'Yes')
    expect(result.tokenId).toBe('tok-yes')
  })

  it('resolves No to the No-outcome token', () => {
    const result = resolveOrderToken(market(), 'No')
    expect(result.tokenId).toBe('tok-no')
  })

  it('resolves correctly even when Gamma lists No before Yes', () => {
    const m = market({ outcomes: '["No","Yes"]', clobTokenIds: ['tok-no', 'tok-yes'] })
    expect(resolveOrderToken(m, 'Yes').tokenId).toBe('tok-yes')
    expect(resolveOrderToken(m, 'No').tokenId).toBe('tok-no')
  })

  it('carries negRisk and tickSize from the market record, not from caller input', () => {
    const m = market({ negRisk: true, tickSize: '0.001' })
    const result = resolveOrderToken(m, 'Yes')
    expect(result.negRisk).toBe(true)
    expect(result.tickSize).toBe('0.001')
  })

  it('defaults negRisk to false when the market omits it', () => {
    const m = market({ negRisk: undefined })
    expect(resolveOrderToken(m, 'Yes').negRisk).toBe(false)
  })

  it('throws a typed error when the market has no token for that outcome slot', () => {
    const m = market({ clobTokenIds: ['tok-yes'] }) // No-slot missing
    expect(() => resolveOrderToken(m, 'No')).toThrow('market_missing_token_for_outcome:No')
  })
})
