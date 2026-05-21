import { describe, expect, it } from 'vitest'

// Re-creates the matcher's private helpers for unit testing. Kept in sync
// with matcher.ts manually.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'would',
  'should', 'could', 'have', 'has', 'had', 'are', 'was', 'were', 'been',
  'being', 'into', 'about', 'after', 'before', 'over', 'under', 'than',
  'then', 'them', 'they', 'their', 'there', 'these', 'those',
  'say', 'says', 'said', 'tell', 'told', 'reports', 'report', 'sources',
  'exclusive', 'breaking', 'update', 'updates', 'announcement',
])

const LOW_VALUE_OVERLAP = new Set([
  'iran', 'iraq', 'isra', 'russ', 'ukra', 'chin', 'unit', 'amer',
  'trum', 'bide', 'puti', 'zele', 'netan',
  'pres', 'gove', 'lead', 'mini', 'admi',
  'mark', 'pric', 'rate', 'cost',
  'year', 'mont', 'week',
  'will',
])

function extractKeywords(text: string): Set<string> {
  const out = new Set<string>()
  const words = text.toLowerCase().match(/[a-z][a-z']{3,}/g) ?? []
  for (const w of words) {
    if (!STOPWORDS.has(w)) out.add(w)
  }
  return out
}

function stem(w: string): string {
  return w.slice(0, 4)
}

function keywordOverlapBonus(headlineKw: Set<string>, marketQuestion: string): number {
  if (headlineKw.size === 0) return 0
  const marketKw = extractKeywords(marketQuestion)
  const marketStems = new Set<string>()
  for (const w of marketKw) marketStems.add(stem(w))
  let bonus = 0
  for (const w of headlineKw) {
    const s = stem(w)
    if (!marketStems.has(s)) continue
    bonus += LOW_VALUE_OVERLAP.has(s) ? 0.01 : 0.04
  }
  return Math.min(0.15, bonus)
}

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
    // Gap of 0.07 is large enough to flip the ranking even when Pahlavi's
    // raw cosine starts ~0.005 higher than uranium's (the case in production).
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
    // "rate" stem is LOW_VALUE (0.01); rates → "rate", market has no "rate"
    expect(keywordOverlapBonus(headline, market)).toBe(0)
  })

  it('treats morphological variants as overlap via prefix stem (Iran ↔ Iranian)', () => {
    const h = new Set(['iran']) // stem "iran"
    // Iranian → stem "iran" → low-value, gets 0.01
    expect(keywordOverlapBonus(h, 'Iranian uranium deal')).toBe(0.01)
  })

  it('rewards SPECIFIC nouns more than generic country/leader words', () => {
    const headline = extractKeywords('Trump signs tariffs deal with China')
    // Specific markets vs generic ones:
    const specific = 'Will Trump impose 50%+ tariffs on China by July?'
    const generic = 'Will Trump win the election?'
    const bSpec = keywordOverlapBonus(headline, specific)
    const bGen = keywordOverlapBonus(headline, generic)
    // Specific has "tariffs" (non-low-value, +0.04) which generic lacks
    expect(bSpec).toBeGreaterThan(bGen)
  })
})
