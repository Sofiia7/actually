import type { MatchResult, PolyMarket, Settings } from '../shared/types'
import {
  COLOR_THRESHOLDS,
  HEADLINE_WEIGHT,
  MAX_BODY_TEXT_CHARS,
} from '../shared/constants'
import { embed } from './embeddings'
import { getMarketCache } from './cache'
import { b64ToFloatArray, cosineSimilarity, findOutcomeIndex } from './util'

function getColor(prob: number): MatchResult['color'] {
  if (prob < COLOR_THRESHOLDS.blue) return 'blue'
  if (prob < COLOR_THRESHOLDS.yellow) return 'yellow'
  return 'red'
}

// Words that carry no topical signal — common in both news and market questions.
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
function extractKeywords(text: string): Set<string> {
  const out = new Set<string>()
  const words = text.toLowerCase().match(/[a-z][a-z']{3,}/g) ?? []
  for (const w of words) {
    if (!STOPWORDS.has(w)) out.add(w)
  }
  return out
}

// Words that are too generic to discriminate — they appear in a huge fraction
// of news headlines and Polymarket questions, so giving them a topical bonus
// rewards thematic generality rather than specificity. Kept narrow on purpose
// (this is NOT a general-purpose stopword list — those are STOPWORDS above).
const LOW_VALUE_OVERLAP = new Set([
  'iran', 'iraq', 'isra', 'russ', 'ukra', 'chin', 'unit', 'amer', // countries
  'trum', 'bide', 'puti', 'zele', 'netan', // leader-name prefixes (4-char stems)
  'pres', 'gove', 'lead', 'mini', 'admi', // generic political roles
  'mark', 'pric', 'rate', 'cost', // generic econ
  'year', 'mont', 'week', // generic time
  'will', // shouldn't appear thanks to STOPWORDS but safety
])

/**
 * Topical-overlap bonus. For each headline content-word that also appears in
 * the market question (via prefix-stem), add 0.04 — but only if the stem is
 * NOT in LOW_VALUE_OVERLAP. Common-noise stems like "iran", "lead", "pres"
 * give a smaller 0.01 bonus so they don't dominate when the specific noun is
 * what should actually flip ranking (e.g. "uranium" over generic "Iran").
 * Bonus capped at 0.15 so it can outweigh ~0.03 cosine gaps but not derail
 * clearly-better semantic matches (~0.10 gap is preserved).
 */
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

/**
 * Cheap stem: take the first 4 chars (lowercase), good enough for English news
 * vocabulary as a tiebreaker. Catches Iran/Iranian, uranium/uranic, elect/elected.
 * Will collide on unrelated words sharing a prefix (e.g. "bank" / "banking" — fine;
 * "bank" / "banner" — false-positive, but rare and bounded by per-overlap cap).
 */
function stem(w: string): string {
  return w.slice(0, 4)
}

function priceFromOutcomes(outcomePrices: string, outcomesJson: string): number {
  // Probability shown is always the YES side. Map by label since some markets
  // list "No" first.
  const yesIdx = findOutcomeIndex(outcomesJson, 'Yes')
  try {
    const arr = JSON.parse(outcomePrices) as string[]
    return parseFloat(arr[yesIdx] ?? '0')
  } catch {
    return 0
  }
}

export async function findMatch(
  headline: string,
  bodyText: string,
  settings: Settings,
): Promise<MatchResult | null> {
  const cache = await getMarketCache()
  if (cache.length === 0) return null

  const trimmedBody = bodyText.slice(0, MAX_BODY_TEXT_CHARS)
  const inputText =
    Array(HEADLINE_WEIGHT).fill(headline).join(' ') + ' ' + trimmedBody

  const articleVec = await embed(
    settings.embeddingProvider,
    inputText,
    settings.workerUrl,
    settings.workerSecret,
  )

  // Topic-specific content words from the headline. When the article is about
  // "uranium", markets whose question contains "uranium" should rank above
  // generically-Iran markets. Cosine alone treats every "Iran"-mentioning
  // market as similarly close, so we add a lexical-overlap boost on top.
  const headlineKeywords = extractKeywords(headline)

  // Score every market. Three additive components:
  //   1. raw cosine similarity (semantic relatedness)
  //   2. lexical-overlap bonus (+0.025 per keyword shared, capped +0.075) —
  //      catches topical specificity that embeddings smooth over
  //   3. small volume bonus (capped +0.015) — tiebreaker for genuine ties
  const scored: { market: PolyMarket; score: number; raw: number }[] = []
  for (const m of cache) {
    if (!m.embeddingB64) continue
    const v = b64ToFloatArray(m.embeddingB64)
    if (v.length !== articleVec.length) continue
    const raw = cosineSimilarity(articleVec, v)
    const kwBonus = keywordOverlapBonus(headlineKeywords, m.question)
    const volBonus = m.volume > 0 ? Math.min(0.015, 0.002 * Math.log10(m.volume)) : 0
    scored.push({ market: m, score: raw + kwBonus + volBonus, raw })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return null

  // Compare thresholds against the raw semantic score (not the boosted one),
  // so the volume bonus only acts as a tiebreaker, not a confidence inflator.
  const isAboveThreshold = top.raw >= settings.confidenceThreshold
  const isAboveFloor = top.raw >= settings.lowConfidenceFloor
  if (!isAboveFloor) return null

  const probability = priceFromOutcomes(top.market.outcomePrices, top.market.outcomes)
  const alternatives = scored.slice(1, 5).map((s) => s.market)
  const alternativeScores = scored.slice(1, 5).map((s) => s.score)

  return {
    market: top.market,
    probability,
    confidence: top.raw,
    color: getColor(probability),
    lowConfidence: !isAboveThreshold,
    alternatives,
    alternativeScores,
  }
}
