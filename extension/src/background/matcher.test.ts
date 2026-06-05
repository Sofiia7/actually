import { describe, expect, it } from 'vitest'
// Import the real matcher internals (no copy-paste) so these tests track the
// production implementation. extractKeywords / keywordOverlapBonus are exported
// from matcher.ts for exactly this purpose.
import { extractKeywords, keywordOverlapBonus } from './matcher'

describe('extractKeywords', () => {
  it('keeps content words ≥4 chars, drops stopwords', () => {
    const kw = extractKeywords('Exclusive: Supreme Leader says enriched uranium must stay in Iran')
    expect(kw.has('supreme')).toBe(true)
    expect(kw.has('leader')).toBe(true)
    expect(kw.has('enriched')).toBe(true)
    expect(kw.has('uranium')).toBe(true)
    expect(kw.has('iran')).toBe(true)
    expect(kw.has('exclusive')).toBe(false)
    expect(kw.has('says')).toBe(false)
  })

  it('drops words <4 chars', () => {
    expect(extractKeywords('big').size).toBe(0)
    expect(extractKeywords('fire').has('fire')).toBe(true)
  })

  it('dedups case', () => {
    expect(extractKeywords('Iran iran IRAN').size).toBe(1)
  })
})

describe('keywordOverlapBonus — uranium vs Pahlavi case', () => {
  it('uranium market clearly outranks Pahlavi market on a uranium article', () => {
    const headline = extractKeywords('Supreme Leader says enriched uranium must stay in Iran')
    const uraniumMkt = 'US obtains Iranian enriched uranium by May 31?'
    const pahlaviMkt = 'Will Reza Pahlavi lead Iran in 2026?'
    const bonusUranium = keywordOverlapBonus(headline, uraniumMkt)
    const bonusPahlavi = keywordOverlapBonus(headline, pahlaviMkt)
    // Uranium overlaps: iran (low-value 0.01) + enri (0.04) + uran (0.04) = 0.09
    // Pahlavi overlaps: lead (low-value 0.01) + iran (low-value 0.01) = 0.02
    expect(bonusUranium).toBeCloseTo(0.09, 6)
    expect(bonusPahlavi).toBeCloseTo(0.02, 6)
    expect(bonusUranium - bonusPahlavi).toBeGreaterThan(0.05)
  })

  it('caps at 0.15', () => {
    const headline = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])
    expect(keywordOverlapBonus(headline, 'alpha beta gamma delta epsilon zeta')).toBe(0.15)
  })

  it('returns 0 for empty headline keywords', () => {
    expect(keywordOverlapBonus(new Set(), 'anything')).toBe(0)
  })

  it('returns 0 for no overlap', () => {
    const headline = extractKeywords('Fed cuts interest rates by 25 basis points')
    const market = 'Will the price of GPT-5 access drop below $5?'
    expect(keywordOverlapBonus(headline, market)).toBe(0)
  })

  it('treats morphological variants as overlap via prefix stem (Iran ↔ Iranian)', () => {
    const h = new Set(['iran'])
    expect(keywordOverlapBonus(h, 'Iranian uranium deal')).toBe(0.01)
  })

  it('rewards SPECIFIC nouns more than generic country/leader words', () => {
    const headline = extractKeywords('Trump signs tariffs deal with China')
    const specific = 'Will Trump impose 50%+ tariffs on China by July?'
    const generic = 'Will Trump win the election?'
    expect(keywordOverlapBonus(headline, specific)).toBeGreaterThan(keywordOverlapBonus(headline, generic))
  })
})
