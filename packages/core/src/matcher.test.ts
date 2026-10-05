import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attemptMatch,
  bracketScore,
  extractKeywords,
  extractNumericTokens,
  farFutureYearScore,
  findMatch,
  keywordOverlapBonus,
  numberOverlapScore,
  priceSubjectScore,
} from './matcher'
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
    active: rest.active ?? true,
    closed: rest.closed ?? false,
    endDate: rest.endDate,
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

describe('keywordOverlapBonus - uranium vs Pahlavi case', () => {
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
    // Only 'july' overlaps - a month name must score like 'year'/'week' (0.01),
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

// A bracket market ("by 30%-35%") is one slice of a many-way event: only an
// article that names a number in that slice is about it. Election season
// fills the cache with them, one per district and margin.
describe('bracketScore', () => {
  const none = new Set<string>()

  it('marks down a bracket the headline gives no number for', () => {
    expect(bracketScore(none, 'Will the Democratic Party candidate win the 2026 MI-11 House election by 30%-35%?')).toBeCloseTo(-0.05, 6)
    expect(bracketScore(none, 'Will the Fed funds rate be between 3.25% and 3.5% in December?')).toBeCloseTo(-0.05, 6)
    expect(bracketScore(none, 'Will Bitcoin close the year between $100k-$105k?')).toBeCloseTo(-0.05, 6)
  })

  it('reads a range written with an en dash', () => {
    const q = `Will Flávio Bolsonaro win the first round by 15${String.fromCharCode(0x2013)}20%?`
    expect(bracketScore(none, q)).toBeCloseTo(-0.05, 6)
  })

  it('treats "exactly N" as a one-number bracket', () => {
    const q = 'Will the Republican Party hold exactly 52 Senate seats after the 2026 midterm elections?'
    expect(bracketScore(none, q)).toBeCloseTo(-0.05, 6)
    expect(bracketScore(extractNumericTokens('Republicans on track for 52 Senate seats'), q)).toBe(0)
  })

  it('leaves the bracket alone when a headline number falls inside it', () => {
    expect(bracketScore(extractNumericTokens('Democrat leads MI-11 race by 32%'), 'Will the Democratic Party candidate win the 2026 MI-11 House election by 30%-35%?')).toBe(0)
  })

  it('does not mistake a district code, a season or a plain threshold for a bracket', () => {
    expect(bracketScore(none, 'Will the Democratic Party win the MN-02 House seat?')).toBe(0)
    expect(bracketScore(none, 'Will Arsenal win the 2026-27 English Premier League?')).toBe(0)
    expect(bracketScore(none, 'Will Bitcoin reach $120,000 by December 31, 2026?')).toBe(0)
    expect(bracketScore(none, 'Will the Fed decrease interest rates by 25 bps after the October 2026 meeting?')).toBe(0)
  })
})

// A market about a year two or more ahead is a different contest from the
// one in today's news, unless the article itself says that year.
describe('farFutureYearScore', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')

  it('marks down a market two or more years out that the article never mentions', () => {
    expect(farFutureYearScore('Democrats hold midterm lead with independents', 'Will the Democrats win the 2028 US Presidential Election?', now)).toBeCloseTo(-0.05, 6)
  })

  it('leaves it alone when the article does mention that year', () => {
    expect(farFutureYearScore('Democrats eye the 2028 White House race', 'Will the Democrats win the 2028 US Presidential Election?', now)).toBe(0)
  })

  it('leaves next year and the current year alone - a season or final that ends next year is still today\'s news', () => {
    expect(farFutureYearScore('Chiefs win again', 'Will the Chiefs win Super Bowl 2027?', now)).toBe(0)
    expect(farFutureYearScore('Arsenal go top', 'Will Arsenal win the 2026-27 English Premier League?', now)).toBe(0)
    expect(farFutureYearScore('Midterms tighten', 'Will the Democratic Party control the House after the 2026 Midterm elections?', now)).toBe(0)
  })
})

describe('findMatch - a midterms article finds the midterms market (live failure 2026-10-05)', () => {
  const thresholds = { confidenceThreshold: 0.45, lowConfidenceFloor: 0.35 }
  const at = (raw: number) => [raw, Math.sqrt(1 - raw * raw), 0]

  afterEach(() => {
    vi.useRealTimers()
  })

  // Raw cosines and volumes as the live cache scored PBS's "Democrats hold
  // midterm lead..." on 2026-10-05: a $7.7k district-margin bracket and a
  // 2028 market both outranked the $7.8M House-control market the article
  // is actually about.
  const markets = () => [
    fakeMarket({ id: 'mi11', question: 'Will the Democratic Party candidate win the 2026 MI-11 House election by 30%-35%?', volume: 7_740, vec: at(0.552) }),
    fakeMarket({ id: 'pres2028', question: 'Will the Democrats win the 2028 US Presidential Election?', volume: 1_225_001, vec: at(0.544) }),
    fakeMarket({ id: 'house', question: 'Will the Democratic Party control the House after the 2026 Midterm elections?', volume: 7_796_564, vec: at(0.493) }),
  ]
  const embedder = { embed: async () => new Float32Array([1, 0, 0]) }

  it('puts the House-control market on top', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00Z') })
    const result = await findMatch(
      'Democrats hold midterm lead with independents breaking sharply against Trump',
      "President Donald Trump's efforts to make the midterm elections a referendum on his presidency appear to be backfiring.",
      { store: { getMarkets: async () => markets() }, embedder, thresholds },
    )
    expect(result?.market.id).toBe('house')
  })

  it('still picks the 2028 market for an article that is about 2028', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00Z') })
    const result = await findMatch(
      'Democrats eye the 2028 White House race as hopefuls line up',
      'Potential 2028 candidates are already visiting early primary states.',
      { store: { getMarkets: async () => markets() }, embedder, thresholds },
    )
    expect(result?.market.id).toBe('pres2028')
  })
})

describe('priceSubjectScore', () => {
  const crashStory =
    'Worried About a Stock Market Crash? History Says Not So Fast. Every bear market in the S&P 500 has ended in a bull market.'

  it('marks down a price market whose asset the article never names', () => {
    expect(priceSubjectScore(crashStory, 'Will Ethereum dip to $1,500 by December 31, 2026?')).toBeCloseTo(-0.05, 6)
    expect(priceSubjectScore(crashStory, 'Will the price of Bitcoin be above $88,000 on October 5?')).toBeCloseTo(-0.05, 6)
    expect(priceSubjectScore(crashStory, 'Will Gold (GC) hit (HIGH) $6,000 by end of December?')).toBeCloseTo(-0.05, 6)
  })

  it('leaves it alone when the article names the asset, by name or by ticker', () => {
    expect(priceSubjectScore('Ethereum slides toward $2,000', 'Will Ethereum dip to $1,500 by December 31, 2026?')).toBe(0)
    expect(priceSubjectScore('ETH slides toward $2,000', 'Will Ethereum dip to $1,500 by December 31, 2026?')).toBe(0)
    expect(priceSubjectScore('BTC tops $120,000 for the first time', 'Will Bitcoin reach $150,000 in October?')).toBe(0)
    expect(priceSubjectScore('Oil jumps after OPEC cuts output', 'Will WTI Crude Oil (WTI) hit (HIGH) $100 in October?')).toBe(0)
  })

  it('counts a story about crypto as a whole as naming every coin', () => {
    expect(priceSubjectScore('Crypto sell-off deepens as traders flee risk', 'Will Solana reach $600 by December 31, 2026?')).toBe(0)
  })

  it('goes by the name, not by filler words like market or cap', () => {
    const q = "Will Anthropic's market cap be between $2.25T and $2.5T at market close on IPO day?"
    expect(priceSubjectScore('Stock market rally lifts big tech valuations', q)).toBeCloseTo(-0.05, 6)
    expect(priceSubjectScore('Anthropic files for its IPO', q)).toBe(0)
    expect(priceSubjectScore('Token launches surge this week', 'Variational FDV above $1B one day after launch?')).toBeCloseTo(-0.05, 6)
  })

  it('ignores markets that are not about a price', () => {
    expect(priceSubjectScore(crashStory, 'AI bubble burst in 2026?')).toBe(0)
    expect(priceSubjectScore(crashStory, 'US recession by end of 2026?')).toBe(0)
    expect(priceSubjectScore(crashStory, 'Will Trump sign a $1 trillion infrastructure bill?')).toBe(0)
  })
})

describe('findMatch - a stock market article does not land on a crypto price market (live failure 2026-10-05)', () => {
  const thresholds = { confidenceThreshold: 0.45, lowConfidenceFloor: 0.35 }
  const at = (raw: number) => [raw, Math.sqrt(1 - raw * raw), 0]

  // Raw cosines and volumes as the live cache scored Motley Fool's "Worried
  // About a Stock Market Crash?" with its body on 2026-10-05. The cache had
  // no stock market market at all, and an Ethereum price ladder came first.
  const markets = () => [
    fakeMarket({ id: 'eth', question: 'Will Ethereum dip to $2,000 by December 31, 2026?', volume: 555_260, vec: at(0.484) }),
    fakeMarket({ id: 'ai', question: 'AI bubble burst in 2026?', volume: 2_426_380, vec: at(0.478) }),
    fakeMarket({ id: 'recession', question: 'US recession by end of 2026?', volume: 2_254_219, vec: at(0.462) }),
  ]
  const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
  const store = { getMarkets: async () => markets() }

  it('puts a stock market market ahead of the crypto ladder', async () => {
    const result = await findMatch(
      'Worried About a Stock Market Crash? History Says Not So Fast.',
      'Every bear market in the history of the S&P 500 has been followed by a bull market that reached new highs.',
      { store, embedder, thresholds },
    )
    expect(result?.market.id).not.toBe('eth')
    expect(result?.alternatives.map((m) => m.id)).toContain('recession')
  })

  it('still picks the Ethereum market for an article about Ethereum', async () => {
    const result = await findMatch(
      'Ethereum slides toward $2,000 as the crypto sell-off deepens',
      'Ether fell 8% on the day.',
      { store, embedder, thresholds },
    )
    expect(result?.market.id).toBe('eth')
  })
})

describe('findMatch - number-aware ranking', () => {
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
    // [0.6, 0.8, 0] is a unit vector; cosine against [1,0,0] is exactly 0.6 -
    // above the 0.5 floor but below the 0.8 threshold.
    const mkt = fakeMarket({ vec: [0.6, 0.8, 0] })
    const store = { getMarkets: async () => [mkt] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).not.toBeNull()
    expect(result?.confidence).toBeCloseTo(0.6, 6)
    expect(result?.lowConfidence).toBe(true)
  })

  it('never returns a closed market, even as the only/best cosine match', async () => {
    const closed = fakeMarket({ id: 'closed', closed: true, vec: [1, 0, 0] })
    const store = { getMarkets: async () => [closed] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).toBeNull()
  })

  it('never returns a market whose endDate has already passed', async () => {
    const resolved = fakeMarket({
      id: 'resolved',
      vec: [1, 0, 0],
      endDate: new Date(Date.now() - 60_000).toISOString(),
    })
    const store = { getMarkets: async () => [resolved] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result).toBeNull()
  })

  it('falls through to the next-best live market when the top cosine match is closed', async () => {
    const closed = fakeMarket({ id: 'closed', closed: true, vec: [1, 0, 0] })
    const live = fakeMarket({ id: 'live', vec: [0.9, 0.436, 0] }) // still above the 0.5 floor
    const store = { getMarkets: async () => [closed, live] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result?.market.id).toBe('live')
  })

  it('still returns a market with a future endDate', async () => {
    const upcoming = fakeMarket({
      id: 'upcoming',
      vec: [1, 0, 0],
      endDate: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const store = { getMarkets: async () => [upcoming] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const result = await findMatch('anything', '', { store, embedder, thresholds })
    expect(result?.market.id).toBe('upcoming')
  })
})

describe('attemptMatch - a failed check has to be able to say why', () => {
  const thresholds = { confidenceThreshold: 0.8, lowConfidenceFloor: 0.5 }

  it('names the market it came closest to when nothing clears the floor', async () => {
    // Without this the popup could only report counters ("cache=789/
    // embedded=789/floor=0.35"), which told the user nothing about their
    // article and read as a malfunction rather than an honest miss.
    const far = fakeMarket({ id: 'far', question: 'Will the Lakers win?', vec: [0, 1, 0] })
    const store = { getMarkets: async () => [far] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const attempt = await attemptMatch('Iran enriches uranium past 60%', '', { store, embedder, thresholds })
    expect(attempt.match).toBeNull()
    expect(attempt.nearest?.question).toBe('Will the Lakers win?')
    expect(attempt.nearest?.score).toBeLessThan(thresholds.lowConfidenceFloor)
    expect(attempt.scored).toBe(1)
  })

  it('reports scored=0 for an empty cache - a different failure from "checked everything and nothing fit"', async () => {
    const store = { getMarkets: async () => [] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const attempt = await attemptMatch('anything', '', { store, embedder, thresholds })
    expect(attempt).toEqual({ match: null, nearest: null, scored: 0 })
  })

  it('counts only scoreable markets - closed ones are not something the user could have traded', async () => {
    const closed = fakeMarket({ id: 'closed', closed: true, vec: [1, 0, 0] })
    const far = fakeMarket({ id: 'far', question: 'Will the Lakers win?', vec: [0, 1, 0] })
    const store = { getMarkets: async () => [closed, far] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const attempt = await attemptMatch('Iran enriches uranium', '', { store, embedder, thresholds })
    expect(attempt.scored).toBe(1)
    expect(attempt.nearest?.question).toBe('Will the Lakers win?')
  })

  it('does not let a boosted below-floor candidate hide a candidate that clears the floor on raw score alone (2026-09-08 audit F06)', async () => {
    // "eligible" clears the 0.35 floor on raw cosine alone (0.40) but shares
    // no keywords with the headline, so it gets no bonus. "weak" scores only
    // 0.34 raw (below the floor) but its question repeats every headline
    // keyword, boosting it to 0.34+0.12=0.46 - ahead of eligible's
    // 0.40+0.004=0.404. Sorting by the BOOSTED score before checking the
    // floor picked "weak" as top, and its raw score failed the floor check -
    // hiding "eligible" entirely even though it plainly qualified.
    const eligible = fakeMarket({ id: 'eligible', question: 'Another event entirely', vec: [0.40, Math.sqrt(1 - 0.4 ** 2)] })
    const weak = fakeMarket({ id: 'weak', question: 'Uranium enrichment sanctions', vec: [0.34, Math.sqrt(1 - 0.34 ** 2)] })
    const store = { getMarkets: async () => [eligible, weak] }
    const embedder = { embed: async () => new Float32Array([1, 0]) }
    const attempt = await attemptMatch('Uranium enrichment sanctions', '', {
      store, embedder, thresholds: { confidenceThreshold: 0.8, lowConfidenceFloor: 0.35 },
    })
    expect(attempt.scored).toBe(2)
    expect(attempt.match?.market.id).toBe('eligible')
  })

  it('reports alternativeRawScores separately from the boosted alternativeScores, so promoting one to featured never has to trust a bonus-inflated number as a probability-like confidence (2026-09-08 audit F20)', async () => {
    const top = fakeMarket({ id: 'top', question: 'Totally unrelated', vec: [1, 0] })
    // Shares every headline keyword, so its RANKING score is boosted well
    // above its raw cosine - exactly the number a UI must NOT read as
    // "confidence" when this becomes the featured match.
    const alt = fakeMarket({ id: 'alt', question: 'Uranium enrichment sanctions', vec: [0.5, Math.sqrt(1 - 0.5 ** 2)] })
    const store = { getMarkets: async () => [top, alt] }
    const embedder = { embed: async () => new Float32Array([1, 0]) }
    const attempt = await attemptMatch('Uranium enrichment sanctions', '', {
      store, embedder, thresholds: { confidenceThreshold: 0.8, lowConfidenceFloor: 0.35 },
    })
    expect(attempt.match?.alternatives[0]?.id).toBe('alt')
    expect(attempt.match?.alternativeRawScores?.[0]).toBeCloseTo(0.5, 6)
    // The boosted score is a different (higher) number, confirming these
    // two arrays are not accidentally the same values twice.
    expect(attempt.match?.alternativeScores?.[0]).toBeGreaterThan(attempt.match?.alternativeRawScores?.[0] ?? 0)
  })

  it('carries the match through unchanged when one does clear the floor', async () => {
    const close = fakeMarket({ id: 'close', question: 'Will Iran enrich uranium?', vec: [1, 0, 0] })
    const store = { getMarkets: async () => [close] }
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) }
    const attempt = await attemptMatch('Iran enriches uranium past 60%', '', { store, embedder, thresholds })
    expect(attempt.match?.market.id).toBe('close')
    expect(attempt.nearest?.question).toBe('Will Iran enrich uranium?')
    // findMatch stays the thin wrapper every existing caller expects.
    const legacy = await findMatch('Iran enriches uranium past 60%', '', { store, embedder, thresholds })
    expect(legacy?.market.id).toBe('close')
  })
})

describe('attemptMatch - the long-tail search fallback', () => {
  const thresholds = { confidenceThreshold: 0.8, lowConfidenceFloor: 0.5 }
  const embedder = { embed: async () => new Float32Array([1, 0, 0]) }

  /** A search hit, shaped as Gamma returns it: no embedding of its own. */
  function searchHit(question: string) {
    const { embeddingB64: _e, questionHash: _h, cachedAt: _c, ...rest } = fakeMarket({ id: 'tail', question, vec: [1, 0, 0] })
    return rest
  }

  it('finds a market the cache never held - the whole point of the fallback', async () => {
    // A real, open, actively-traded market can sit below the cache cut: the
    // live floor was $508,649 of lifetime volume, and "Who will Trump
    // publicly insult by August 31?" trades at $47,851. To the user that
    // looked exactly like the market not existing.
    const store = { getMarkets: async () => [fakeMarket({ id: 'cached', question: 'Will the Lakers win?', vec: [0, 1, 0] })] }
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store, embedder, thresholds,
      searchFallback: async () => [searchHit('Will Iran enrich uranium?')],
    })
    expect(attempt.match?.market.question).toBe('Will Iran enrich uranium?')
  })

  it('is not consulted when the cache already has an answer', async () => {
    const store = { getMarkets: async () => [fakeMarket({ id: 'cached', question: 'Will Iran enrich uranium?', vec: [1, 0, 0] })] }
    const searchFallback = vi.fn(async () => [searchHit('anything')])
    const attempt = await attemptMatch('Iran enriches uranium', '', { store, embedder, thresholds, searchFallback })
    expect(attempt.match?.market.id).toBe('cached')
    expect(searchFallback).not.toHaveBeenCalled()
  })

  it('holds the floor - search results are scored, not trusted', async () => {
    // Polymarket's search is lexical, so it answers almost any query with
    // something. Returning its top hit unscored would turn "no match" into a
    // confidently wrong match, which is strictly worse than an honest miss.
    const store = { getMarkets: async () => [] }
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store,
      embedder: { embed: async (t: string) => (t.includes('uranium') ? new Float32Array([1, 0, 0]) : new Float32Array([0, 1, 0])) },
      thresholds,
      searchFallback: async () => [searchHit('Will the Lakers win?')],
    })
    expect(attempt.match).toBeNull()
    expect(attempt.nearest?.question).toBe('Will the Lakers win?')
  })

  it('reports whichever miss got closer, cached or searched', async () => {
    const store = { getMarkets: async () => [fakeMarket({ id: 'cached', question: 'Far cached market', vec: [0, 1, 0] })] }
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store,
      embedder: { embed: async (t: string) => (t.includes('uranium') ? new Float32Array([1, 0, 0]) : new Float32Array([0.9, 0.436, 0])) },
      thresholds: { confidenceThreshold: 0.99, lowConfidenceFloor: 0.95 },
      searchFallback: async () => [searchHit('Closer searched market')],
    })
    expect(attempt.match).toBeNull()
    expect(attempt.nearest?.question).toBe('Closer searched market')
  })

  it('does not let a boosted below-floor search hit hide one that clears the floor on raw score alone (2026-09-08 audit F06)', async () => {
    // Same bug as the cached-candidates case above, in the search-fallback
    // path's own separate sort.
    const store = { getMarkets: async () => [] }
    const attempt = await attemptMatch('Uranium enrichment sanctions', '', {
      store,
      embedder: {
        embed: async (t: string) => {
          if (t.includes('Another event entirely')) return new Float32Array([0.40, Math.sqrt(1 - 0.4 ** 2)])
          if (t.includes('loom')) return new Float32Array([0.34, Math.sqrt(1 - 0.34 ** 2)])
          return new Float32Array([1, 0])
        },
      },
      thresholds: { confidenceThreshold: 0.8, lowConfidenceFloor: 0.35 },
      searchFallback: async () => [searchHit('Another event entirely'), searchHit('Uranium enrichment sanctions loom')],
    })
    expect(attempt.match?.market.question).toBe('Another event entirely')
  })

  it('never offers a non-binary (Over/Under etc.) search hit as a YES/NO match (2026-09-08 audit F15)', async () => {
    // The cache builder already drops non-binary markets before they're
    // cached (isBinaryOutcomes), but the live search fallback bypassed that
    // filter entirely - a categorical market came back scored exactly like
    // a real Yes/No one, with a meaningless "probability" (outcome[0]'s
    // price) and BUY_YES/BUY_NO semantics that don't describe its tokens.
    const store = { getMarkets: async () => [] }
    const nonBinary = { ...searchHit('Will X, Y, or Z win?'), outcomes: '["X","Y","Z"]' }
    const attempt = await attemptMatch('Will X, Y, or Z win?', '', {
      store, embedder, thresholds,
      searchFallback: async () => [nonBinary],
    })
    expect(attempt.match).toBeNull()
  })

  it('still matches a genuine binary search hit alongside a filtered non-binary one', async () => {
    const store = { getMarkets: async () => [] }
    const binary = searchHit('Will Iran enrich uranium?')
    const nonBinary = { ...searchHit('Will X, Y, or Z win?'), outcomes: '["X","Y","Z"]' }
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store, embedder, thresholds,
      searchFallback: async () => [nonBinary, binary],
    })
    expect(attempt.match?.market.question).toBe('Will Iran enrich uranium?')
  })

  it('swallows a search failure - the user already has a true answer', async () => {
    const store = { getMarkets: async () => [fakeMarket({ id: 'cached', question: 'Will the Lakers win?', vec: [0, 1, 0] })] }
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store, embedder, thresholds,
      searchFallback: async () => { throw new Error('network') },
    })
    expect(attempt.match).toBeNull()
    expect(attempt.nearest?.question).toBe('Will the Lakers win?')
  })

  it('still searches when the cache is empty', async () => {
    const attempt = await attemptMatch('Iran enriches uranium', '', {
      store: { getMarkets: async () => [] },
      embedder, thresholds,
      searchFallback: async () => [searchHit('Will Iran enrich uranium?')],
    })
    expect(attempt.match?.market.question).toBe('Will Iran enrich uranium?')
  })

  it('does not search at all when no fallback is provided', async () => {
    const attempt = await attemptMatch('anything', '', {
      store: { getMarkets: async () => [] }, embedder, thresholds,
    })
    expect(attempt).toEqual({ match: null, nearest: null, scored: 0 })
  })
})
