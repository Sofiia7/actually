import { describe, expect, it } from 'vitest'
import { extractKeywords, extractNumericTokens, findMatch, keywordOverlapBonus, numberOverlapScore } from './matcher'
import type { CachedMarket } from './types'
import { floatArrayToB64 } from './util'

function fakeMarket(over: Partial<CachedMarket> & { vec: number[] }): CachedMarket {
  const { vec, ...rest } = over
  return {
    id: rest.id ?? 'm1',
    slug: rest.slug ?? 'slug',
    question: rest.question ?? 'Will X happen?',
    outcomePrices: rest.outcomePrices ?? '["0.5","0.5"]',
    outcomes: rest.outcomes ?? '["Yes","No"]',
    volume: rest.volume ?? 0,
    liquidity: rest.liquidity ?? 0,
    active: true,
    closed: false,
    clobTokenIds: rest.clobTokenIds ?? ['tok-yes', 'tok-no'],
    embeddingB64: floatArrayToB64(new Float32Array(vec)),
    questionHash: 'hash',
    cachedAt: Date.now(),
  }
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

  it('treats month names as low-value overlap (shared "July" is time noise, not topic)', () => {
    const headline = extractKeywords('Bitcoin rally expected in July')
    // Only 'july' overlaps — a month name must score like 'year'/'week' (0.01),
    // not like a topical noun (0.04), or every same-month market gets boosted.
    expect(keywordOverlapBonus(headline, 'Will Ethereum ETF launch in July?')).toBeCloseTo(0.01, 6)
  })
})

describe('extractNumericTokens', () => {
  it('normalizes prices with $ and thousands separators', () => {
    const n = extractNumericTokens('Bitcoin climbs above $120,000 as spot ETF inflows accelerate')
    expect(n.has('120000')).toBe(true)
  })

  it('expands k-suffix and strips % and currency decoration', () => {
    const n = extractNumericTokens('BTC to $120k? Fed odds at 60%')
    expect(n.has('120000')).toBe(true)
    expect(n.has('60')).toBe(true)
  })

  it('keeps decimals canonical', () => {
    const n = extractNumericTokens('rate cut of 0.50 points')
    expect(n.has('0.5')).toBe(true)
  })

  it('returns an empty set for text without digits', () => {
    expect(extractNumericTokens('no numbers in this headline').size).toBe(0)
  })
})

describe('numberOverlapScore', () => {
  it('rewards a shared specific price', () => {
    const h = extractNumericTokens('Bitcoin climbs above $120,000')
    const score = numberOverlapScore(h, 'Will Bitcoin reach $120,000 by December 31, 2026?')
    expect(score).toBeGreaterThanOrEqual(0.08)
  })

  it('penalizes conflicting specific prices (the live $120k→"dip to $57,500" failure)', () => {
    const h = extractNumericTokens('Bitcoin climbs above $120,000')
    expect(numberOverlapScore(h, 'Will Bitcoin dip to $57,500 in July?')).toBeLessThan(0)
  })

  it('is neutral when the market question has no numbers', () => {
    const h = extractNumericTokens('Bitcoin climbs above $120,000')
    expect(numberOverlapScore(h, 'Will Bitcoin hit a new all-time high?')).toBe(0)
  })

  it('is neutral when the headline has no numbers', () => {
    expect(numberOverlapScore(new Set<string>(), 'Will Bitcoin dip to $57,500 in July?')).toBe(0)
  })

  it('treats bare years as weak: shared year is a tiny bonus, differing years are not a conflict', () => {
    const h = extractNumericTokens('What 2026 holds for world markets')
    expect(numberOverlapScore(h, 'Will X happen in 2027?')).toBe(0)
    expect(numberOverlapScore(h, 'Will X happen in 2026?')).toBeCloseTo(0.01, 6)
  })
})

describe('findMatch — number-aware ranking', () => {
  const thresholds = { confidenceThreshold: 0.8, lowConfidenceFloor: 0.3 }

  it('ranks the market sharing the headline price above a closer-by-cosine market with a conflicting price', async () => {
    // Reproduces the live failure: "$120,000" headline confidently matched
    // "dip to $57,500" because the encoder can't tell price levels apart and
    // digits were invisible to the keyword bonus.
    const wrong = fakeMarket({
      id: 'dip',
      question: 'Will Bitcoin dip to $57,500 in July?',
      vec: [1, 0, 0],
    })
    const right = fakeMarket({
      id: 'reach',
      question: 'Will Bitcoin reach $120,000 by December 31, 2026?',
      vec: [0.995, 0.0999, 0], // slightly worse cosine than 'dip'
    })
    const store = { getMarkets: async () => [wrong, right] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch(
      'Bitcoin climbs above $120,000 as spot ETF inflows accelerate',
      '',
      { store, embedder, thresholds },
    )
    expect(result?.market.id).toBe('reach')
  })
})

describe('findMatch', () => {
  const thresholds = { confidenceThreshold: 0.8, lowConfidenceFloor: 0.5 }

  it('returns the highest-cosine market above the floor', async () => {
    const close = fakeMarket({
      id: 'close',
      question: 'Will Iran enrich uranium?',
      outcomePrices: '["0.12","0.88"]',
      vec: [1, 0, 0],
    })
    const far = fakeMarket({
      id: 'far',
      question: 'Will the Lakers win?',
      outcomePrices: '["0.5","0.5"]',
      vec: [0, 1, 0],
    })
    const store = { getMarkets: async () => [far, close] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('Iran enriches uranium past 60%', '', { store, embedder, thresholds })
    expect(result?.market.id).toBe('close')
    expect(result?.probability).toBeCloseTo(0.12, 6)
  })

  it('returns null when the cache is empty', async () => {
    const store = { getMarkets: async () => [] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).toBeNull()
  })

  it('returns null when the best cosine is below lowConfidenceFloor', async () => {
    const mkt = fakeMarket({ vec: [0, 1, 0] })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) } // orthogonal -> cosine 0
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).toBeNull()
  })

  it('sets lowConfidence=true when raw score is between floor and threshold', async () => {
    // [0.6, 0.8, 0] is a unit vector; cosine against [1,0,0] is exactly 0.6 —
    // above the 0.5 floor but below the 0.8 threshold.
    const mkt = fakeMarket({ vec: [0.6, 0.8, 0] })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).not.toBeNull()
    expect(result?.confidence).toBeCloseTo(0.6, 6)
    expect(result?.lowConfidence).toBe(true)
  })
})
