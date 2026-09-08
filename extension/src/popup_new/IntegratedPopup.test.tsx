import { describe, expect, it } from 'vitest'
import { buildMatchFromAlternative } from './IntegratedPopup'
import type { MatchResult, PolyMarket } from '@actually/core'

function fakeMarket(over: Partial<PolyMarket>): PolyMarket {
  return {
    id: over.id ?? 'm1',
    slug: over.slug ?? 'slug',
    question: over.question ?? 'Will X happen?',
    outcomePrices: over.outcomePrices ?? '["0.5","0.5"]',
    outcomes: over.outcomes ?? '["Yes","No"]',
    volume: over.volume ?? 0,
    liquidity: over.liquidity ?? 0,
    active: over.active ?? true,
    closed: over.closed ?? false,
    clobTokenIds: over.clobTokenIds ?? ['tok-yes', 'tok-no'],
  }
}

describe('buildMatchFromAlternative - promoting an alternative to featured (2026-09-08 audit F20)', () => {
  const featured = fakeMarket({ id: 'featured', question: 'Featured market' })
  const altHighBonus = fakeMarket({ id: 'alt-1', question: 'Alt one', outcomePrices: '["0.7","0.3"]' })
  const altLow = fakeMarket({ id: 'alt-2', question: 'Alt two', outcomePrices: '["0.2","0.8"]' })

  const prev: MatchResult = {
    market: featured,
    probability: 0.6,
    confidence: 0.9, // the FEATURED market's own raw score
    color: 'red',
    lowConfidence: false,
    alternatives: [altHighBonus, altLow],
    // Boosted (ranking) scores - deliberately > 1 and NOT in raw-score order,
    // so a bug that reads this array instead of alternativeRawScores is
    // observable rather than accidentally matching by coincidence.
    alternativeScores: [1.05, 0.5],
    // Raw semantic scores - altHighBonus's real similarity is actually LOW
    // despite its inflated ranking score above.
    alternativeRawScores: [0.2, 0.5],
  }

  it('uses the RAW score as the promoted market\'s confidence, not the bonus-inflated ranking score', () => {
    const next = buildMatchFromAlternative(prev, 0, 0.5)
    expect(next?.market.id).toBe('alt-1')
    expect(next?.confidence).toBeCloseTo(0.2, 6) // raw, not the 1.05 ranking score
  })

  it('recomputes lowConfidence for the promoted market instead of copying the previous featured market\'s flag', () => {
    // prev.lowConfidence is false (the ORIGINAL featured market's own flag),
    // but alt-1's raw score (0.2) is well under this 0.5 threshold - the
    // promoted market must say so, not inherit "false" from prev.
    const next = buildMatchFromAlternative(prev, 0, 0.5)
    expect(next?.lowConfidence).toBe(true)
  })

  it('gives a genuinely high-raw-score alternative lowConfidence: false on promotion', () => {
    const next = buildMatchFromAlternative(prev, 1, 0.5) // alt-2, raw 0.5
    expect(next?.confidence).toBeCloseTo(0.5, 6)
    expect(next?.lowConfidence).toBe(false)
  })

  it('demotes the previous featured market with ITS raw score (confidence doubles as its own raw score already)', () => {
    const next = buildMatchFromAlternative(prev, 0, 0.5)
    expect(next?.alternatives[0]?.id).toBe('featured')
    expect(next?.alternativeRawScores?.[0]).toBeCloseTo(0.9, 6)
    expect(next?.alternativeScores?.[0]).toBeCloseTo(0.9, 6)
  })
})
