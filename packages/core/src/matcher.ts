import type { CachedMarket, MatchResult, PolyMarket } from './types'
import { COLOR_THRESHOLDS, HEADLINE_WEIGHT, MAX_BODY_TEXT_CHARS } from './constants'
import { b64ToFloatArray, cosineSimilarity, floatArrayToB64, priceFromOutcomes } from './util'

export interface MarketStore {
  getMarkets(): Promise<CachedMarket[]>
}

export interface Embedder {
  embed(text: string): Promise<Float32Array>
}

export interface MatchThresholds {
  confidenceThreshold: number
  lowConfidenceFloor: number
}

export interface FindMatchDeps {
  store: MarketStore
  embedder: Embedder
  thresholds: MatchThresholds
  /**
   * Long-tail lookup, consulted ONLY after the cached set has failed to clear
   * the floor.
   *
   * However the cache is chosen it is a fixed-size shelf, and Polymarket
   * carries several times more open markets than fit on it. Everything below
   * the cut is invisible - which is how an open, actively-traded market ends
   * up looking to the user like a market that does not exist.
   *
   * Optional because it costs privacy: the query is built from the user's
   * headline and leaves the device. Callers must gate it on explicit consent
   * rather than passing it unconditionally.
   */
  searchFallback?: (headline: string) => Promise<PolyMarket[]>
}

/** Most search candidates we will pay an embedding for. */
const MAX_FALLBACK_CANDIDATES = 25

function getColor(prob: number): MatchResult['color'] {
  if (prob < COLOR_THRESHOLDS.blue) return 'blue'
  if (prob < COLOR_THRESHOLDS.yellow) return 'yellow'
  return 'red'
}

// Words that carry no topical signal - common in both news and market questions.
// Kept short on purpose: this is a tiebreaker, not a stopword analyzer.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'would',
  'should', 'could', 'have', 'has', 'had', 'are', 'was', 'were', 'been',
  'being', 'into', 'about', 'after', 'before', 'over', 'under', 'than',
  'then', 'them', 'they', 'their', 'there', 'these', 'those',
  'say', 'says', 'said', 'tell', 'told', 'reports', 'report', 'sources',
  'exclusive', 'breaking', 'update', 'updates', 'announcement',
])

/** Extract content keywords ≥4 chars, lowercased, deduped, non-stopword. */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>()
  const words = text.toLowerCase().match(/[a-z][a-z']{3,}/g) ?? []
  for (const w of words) {
    if (!STOPWORDS.has(w)) out.add(w)
  }
  return out
}

// Words that are too generic to discriminate - they appear in a huge fraction
// of news headlines and Polymarket questions, so giving them a topical bonus
// rewards thematic generality rather than specificity. Kept narrow on purpose
// (this is NOT a general-purpose stopword list - those are STOPWORDS above).
const LOW_VALUE_OVERLAP = new Set([
  'iran', 'iraq', 'isra', 'russ', 'ukra', 'chin', 'unit', 'amer', // countries
  'trum', 'bide', 'puti', 'zele', 'netan', // leader-name prefixes (4-char stems)
  'pres', 'gove', 'lead', 'mini', 'admi', // generic political roles
  'mark', 'pric', 'rate', 'cost', // generic econ
  'year', 'mont', 'week', // generic time
  'janu', 'febr', 'marc', 'apri', 'june', 'july', 'augu', 'sept', 'octo', 'nove', 'dece', // month stems (≥4 chars; short forms drop out at the regex)
  'will', // shouldn't appear thanks to STOPWORDS but safety
])

/**
 * Topical-overlap bonus. For each headline content-word that also appears in
 * the market question (via prefix-stem), add 0.04 - but only if the stem is
 * NOT in LOW_VALUE_OVERLAP. Common-noise stems like "iran", "lead", "pres"
 * give a smaller 0.01 bonus so they don't dominate when the specific noun is
 * what should actually flip ranking (e.g. "uranium" over generic "Iran").
 * Bonus capped at 0.15 so it can outweigh ~0.03 cosine gaps but not derail
 * clearly-better semantic matches (~0.10 gap is preserved).
 */
export function keywordOverlapBonus(headlineKw: Set<string>, marketQuestion: string): number {
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

/**
 * Cheap stem: take the first 4 chars (lowercase), good enough for English news
 * vocabulary as a tiebreaker. Catches Iran/Iranian, uranium/uranic, elect/elected.
 * Will collide on unrelated words sharing a prefix (e.g. "bank" / "banking" - fine;
 * "bank" / "banner" - false-positive, but rare and bounded by per-overlap cap).
 */
function stem(w: string): string {
  return w.slice(0, 4)
}

/**
 * Extract numeric tokens, canonicalized so headline and question spellings
 * compare equal: thousands separators stripped ("$120,000" → "120000"),
 * k-suffix expanded ("120k" → "120000"), %/currency decoration dropped,
 * decimals normalized via Number ("0.50" → "0.5").
 */
export function extractNumericTokens(text: string): Set<string> {
  const out = new Set<string>()
  const tokens = text.match(/\d[\d,]*(?:\.\d+)?[kK]?%?/g) ?? []
  for (const t of tokens) {
    const kSuffix = /[kK]%?$/.test(t)
    const n = Number(t.replace(/[,%kK]/g, ''))
    if (!Number.isFinite(n)) continue
    out.add(String(kSuffix ? n * 1000 : n))
  }
  return out
}

/** Bare years and single digits carry almost no discriminating signal. */
function isWeakNumber(tok: string): boolean {
  return /^(19|20)\d\d$/.test(tok) || /^\d$/.test(tok)
}

/**
 * Number-overlap score. Specific numbers (price levels, bps, thresholds) are
 * the strongest cheap discriminator news text offers - the embedding model is
 * nearly blind to them ("dip to $57,500" and "reach $120,000" embed almost
 * identically). Shared specific number: +0.08 each (capped with weak bonuses
 * at 0.15). Shared weak number (bare year, single digit): +0.01. When BOTH
 * sides commit to specific numbers and share none, -0.05 - enough to break a
 * near-tie in favor of a level-consistent market, small enough that a clearly
 * better semantic match survives.
 */
export function numberOverlapScore(headlineNums: Set<string>, marketQuestion: string): number {
  if (headlineNums.size === 0) return 0
  const marketNums = extractNumericTokens(marketQuestion)
  if (marketNums.size === 0) return 0
  let bonus = 0
  let sharedStrong = 0
  for (const t of headlineNums) {
    if (!marketNums.has(t)) continue
    if (isWeakNumber(t)) bonus += 0.01
    else { bonus += 0.08; sharedStrong++ }
  }
  if (bonus > 0) return Math.min(0.15, bonus)
  const headlineHasStrong = [...headlineNums].some((t) => !isWeakNumber(t))
  const marketHasStrong = [...marketNums].some((t) => !isWeakNumber(t))
  return headlineHasStrong && marketHasStrong && sharedStrong === 0 ? -0.05 : 0
}

/** The best-scoring tradeable market, even when it fell short of the floor. */
export interface NearestMiss {
  question: string
  slug: string
  /** Raw semantic score, on the same scale as the thresholds. */
  score: number
}

export interface MatchAttempt {
  match: MatchResult | null
  /**
   * What the matcher was closest to when it gave up. Null only when nothing
   * was scoreable at all (empty cache, no embeddings, every market closed).
   *
   * Exists so a failed check can say something true about WHY. The UI used to
   * report "No match (cache=789/embedded=789/floor=0.35)" - three numbers
   * that mean something to whoever wrote them and nothing to anyone else.
   */
  nearest: NearestMiss | null
  /** Markets that made it into scoring: embedded, open, not past end date. */
  scored: number
}

type ScoredRow = { market: CachedMarket; score: number; raw: number }

/**
 * Ask Polymarket's search for markets the cache never had, then score them on
 * exactly the same scale as the cached ones.
 *
 * Each candidate costs one embedding, which is why the list is capped: this
 * runs on the user's own device while they wait, unlike the cached vectors
 * that arrive precomputed. A failure here is deliberately swallowed - the
 * user already has "nothing matched", and turning a fallback's network error
 * into the headline message would replace a true answer with a confusing one.
 */
async function searchAndScore(
  headline: string,
  deps: FindMatchDeps,
  scoreOne: (m: CachedMarket, vec: Float32Array) => ScoredRow | null,
  thresholds: MatchThresholds,
): Promise<{ match: MatchResult | null; nearest: NearestMiss | null; scored: number } | null> {
  if (!deps.searchFallback) return null
  let candidates: PolyMarket[]
  try {
    candidates = await deps.searchFallback(headline)
  } catch {
    return null
  }

  const scored: ScoredRow[] = []
  for (const m of candidates.slice(0, MAX_FALLBACK_CANDIDATES)) {
    const vec = await deps.embedder.embed(m.question)
    const cached: CachedMarket = {
      ...m,
      embeddingB64: floatArrayToB64(vec),
      questionHash: '',
      cachedAt: Date.now(),
    }
    const row = scoreOne(cached, vec)
    if (row) scored.push(row)
  }
  scored.sort((a, b) => b.score - a.score)

  const top = scored[0]
  if (!top) return { match: null, nearest: null, scored: 0 }
  const nearest: NearestMiss = { question: top.market.question, slug: top.market.slug, score: top.raw }
  if (top.raw < thresholds.lowConfidenceFloor) {
    return { match: null, nearest, scored: scored.length }
  }

  const probability = priceFromOutcomes(top.market.outcomePrices, top.market.outcomes)
  return {
    match: {
      market: top.market,
      probability,
      confidence: top.raw,
      color: getColor(probability),
      lowConfidence: top.raw < thresholds.confidenceThreshold,
      alternatives: scored.slice(1, 5).map((r) => r.market),
      alternativeScores: scored.slice(1, 5).map((r) => r.score),
    },
    nearest,
    scored: scored.length,
  }
}

export async function findMatch(
  headline: string,
  bodyText: string,
  deps: FindMatchDeps,
): Promise<MatchResult | null> {
  return (await attemptMatch(headline, bodyText, deps)).match
}

export async function attemptMatch(
  headline: string,
  bodyText: string,
  deps: FindMatchDeps,
): Promise<MatchAttempt> {
  const cache = await deps.store.getMarkets()
  // An empty cache is still worth a search when one is offered - that is the
  // one situation where the shelf being empty is not the end of the story.
  if (cache.length === 0 && !deps.searchFallback) {
    return { match: null, nearest: null, scored: 0 }
  }

  const trimmedBody = bodyText.slice(0, MAX_BODY_TEXT_CHARS)
  const inputText =
    Array(HEADLINE_WEIGHT).fill(headline).join(' ') + ' ' + trimmedBody

  const articleVec = await deps.embedder.embed(inputText)

  // Topic-specific content words from the headline. When the article is about
  // "uranium", markets whose question contains "uranium" should rank above
  // generically-Iran markets. Cosine alone treats every "Iran"-mentioning
  // market as similarly close, so we add a lexical-overlap boost on top.
  const headlineKeywords = extractKeywords(headline)
  const headlineNumbers = extractNumericTokens(headline)

  // Score every market. Four additive components:
  //   1. raw cosine similarity (semantic relatedness)
  //   2. lexical-overlap bonus (see keywordOverlapBonus)
  //   3. number-overlap score (see numberOverlapScore - can be negative)
  //   4. small volume bonus (capped +0.015) - tiebreaker for genuine ties
  const now = Date.now()
  /** Score one market against the article. Null when it is not scoreable. */
  const scoreOne = (
    m: CachedMarket,
    vec: Float32Array,
  ): { market: CachedMarket; score: number; raw: number } | null => {
    // A resolved/closed market must never be offered as a live, tradeable
    // match - the cache can be up to ~2h stale (worker cron) or days stale
    // (extension's lazy refresh), so a market that closed inside that window
    // is otherwise indistinguishable from a live one at scoring time.
    if (m.closed) return null
    if (m.endDate && Date.parse(m.endDate) < now) return null
    if (vec.length !== articleVec.length) return null
    const raw = cosineSimilarity(articleVec, vec)
    const kwBonus = keywordOverlapBonus(headlineKeywords, m.question)
    const numScore = numberOverlapScore(headlineNumbers, m.question)
    const volBonus = m.volume > 0 ? Math.min(0.015, 0.002 * Math.log10(m.volume)) : 0
    return { market: m, score: raw + kwBonus + numScore + volBonus, raw }
  }

  const scored: { market: CachedMarket; score: number; raw: number }[] = []
  for (const m of cache) {
    if (!m.embeddingB64) continue
    const s = scoreOne(m, b64ToFloatArray(m.embeddingB64))
    if (s) scored.push(s)
  }
  scored.sort((a, b) => b.score - a.score)

  const missOf = (
    row: { market: CachedMarket; raw: number } | undefined,
  ): NearestMiss | null =>
    row ? { question: row.market.question, slug: row.market.slug, score: row.raw } : null

  const top = scored[0]
  // Compare thresholds against the raw semantic score (not the boosted one),
  // so the volume bonus only acts as a tiebreaker, not a confidence inflator.
  if (!top || top.raw < deps.thresholds.lowConfidenceFloor) {
    // Nothing on the shelf fits. Ask Polymarket directly, if allowed to.
    const viaSearch = deps.searchFallback
      ? await searchAndScore(headline, deps, scoreOne, deps.thresholds)
      : null
    if (viaSearch?.match) return { ...viaSearch, scored: scored.length + viaSearch.scored }
    // Report whichever attempt got closer, so the UI names the better miss.
    const cachedMiss = missOf(top)
    const searchMiss = viaSearch?.nearest ?? null
    const nearestOverall =
      cachedMiss && searchMiss ? (searchMiss.score > cachedMiss.score ? searchMiss : cachedMiss) : cachedMiss ?? searchMiss
    return {
      match: null,
      nearest: nearestOverall,
      scored: scored.length + (viaSearch?.scored ?? 0),
    }
  }

  const nearest = missOf(top)!
  const isAboveThreshold = top.raw >= deps.thresholds.confidenceThreshold

  const probability = priceFromOutcomes(top.market.outcomePrices, top.market.outcomes)
  const alternatives = scored.slice(1, 5).map((s) => s.market)
  const alternativeScores = scored.slice(1, 5).map((s) => s.score)

  return {
    match: {
      market: top.market,
      probability,
      confidence: top.raw,
      color: getColor(probability),
      lowConfidence: !isAboveThreshold,
      alternatives,
      alternativeScores,
    },
    nearest,
    scored: scored.length,
  }
}
