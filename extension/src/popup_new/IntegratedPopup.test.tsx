import { describe, expect, it } from 'vitest'
import { buildMatchFromAlternative, formatTestResult, relatedRows } from './IntegratedPopup'
import type { MatchResult, PolyMarket } from '@actually/core'
import type { TestKeysResult } from '../shared/types'

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

describe('relatedRows - a related market shows its price, never the ranking score (2026-10-05)', () => {
  // Live case: on a Reuters story about Taiwan the row read 89% beside "Will
  // China invade Taiwan by end of 2026?", a market trading at 2%. The row is
  // drawn exactly like a probability, so the number in it has to be one.
  const match: MatchResult = {
    market: fakeMarket({ id: 'featured', question: 'Will China invade Taiwan by June 30, 2027?' }),
    probability: 0.07,
    confidence: 0.79,
    color: 'blue',
    lowConfidence: false,
    alternatives: [
      fakeMarket({ id: 'a', question: 'Will China invade Taiwan by end of 2026?', outcomePrices: '["0.02","0.98"]' }),
      fakeMarket({ id: 'b', question: 'Listed No first', outcomes: '["No","Yes"]', outcomePrices: '["0.9","0.1"]' }),
      fakeMarket({ id: 'c', question: 'Broken prices', outcomePrices: 'not json' }),
    ],
    alternativeScores: [0.89, 1.12, 0.6],
    alternativeRawScores: [0.7, 0.6, 0.5],
  }

  it("uses each market's own YES price", () => {
    expect(relatedRows(match).map((r) => r.pct)).toEqual([2, 10, 0])
    expect(relatedRows(match).map((r) => r.q)).toEqual([
      'Will China invade Taiwan by end of 2026?',
      'Listed No first',
      'Broken prices',
    ])
  })
})

describe('formatTestResult - auth and cache surface as their own status, not folded into worker (2026-09-08 audit F23)', () => {
  it('shows only Worker when auth/cache were never checked (e.g. worker unreachable)', () => {
    const r: TestKeysResult = { worker: { ok: false, error: 'no_url' } }
    expect(formatTestResult(r)).toBe('Worker ✗ no_url')
  })

  it('shows Worker, Auth and Cache all passing', () => {
    const r: TestKeysResult = {
      worker: { ok: true },
      auth: { ok: true },
      cache: { ok: true },
    }
    expect(formatTestResult(r)).toBe('Worker ✓ · Auth ✓ · Cache ✓')
  })

  it('surfaces an auth failure distinctly from worker reachability', () => {
    const r: TestKeysResult = {
      worker: { ok: true },
      auth: { ok: false, error: 'http_401' },
      cache: { ok: true },
    }
    expect(formatTestResult(r)).toBe('Worker ✓ · Auth ✗ http_401 · Cache ✓')
  })

  it('surfaces a stale-cache failure distinctly from auth', () => {
    const r: TestKeysResult = {
      worker: { ok: true },
      auth: { ok: true },
      cache: { ok: false, error: 'market_cache_stale:30h' },
    }
    expect(formatTestResult(r)).toBe('Worker ✓ · Auth ✓ · Cache ✗ market_cache_stale:30h')
  })
})
