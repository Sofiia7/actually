/**
 * Why did this article match that market? Prints the top markets for one
 * article against the LIVE cache, with every component of the ranking score
 * broken out: raw cosine, keyword bonus, number score, bracket, far-future
 * year, price subject and volume bonus. Needs
 * network and the local model, like live-eval.mts.
 *
 *   npx tsx eval/score-breakdown.mts <article.json> [topN] [regex to also show]
 *
 * article.json is { "headline": ..., "bodyText": ... } - the shape the
 * extension's extractor (and scripts/promo-capture.mts) writes.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  b64ToFloatArray,
  bracketScore,
  cosineSimilarity,
  defaultThresholds,
  extractKeywords,
  extractNumericTokens,
  farFutureYearScore,
  HEADLINE_WEIGHT,
  keywordOverlapBonus,
  LOCAL_MODEL_ID,
  MAX_BODY_TEXT_CHARS,
  numberOverlapScore,
  priceSubjectScore,
} from '../src/index'
import type { CachedMarket } from '../src/types'

const [articlePath, topArg, showArg] = process.argv.slice(2)
const article = JSON.parse(readFileSync(articlePath, 'utf8')) as { headline: string; bodyText: string }
const topN = Number(topArg ?? 12)
const show = showArg ? new RegExp(showArg, 'i') : null

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const env = readFileSync(join(repoRoot, 'extension', '.env.local'), 'utf8')
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
const res = await fetch(`${get('VITE_WORKER_URL')}/market-cache`, { headers: { 'X-Actually-Auth': get('VITE_WORKER_SECRET') } })
if (!res.ok) throw new Error(`market-cache fetch failed: ${res.status}`)
const blob = (await res.json()) as { markets: CachedMarket[] }

const { pipeline, env: tenv } = await import('@xenova/transformers')
tenv.allowLocalModels = false
const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
const input = Array(HEADLINE_WEIGHT).fill(article.headline).join(' ') + ' ' + article.bodyText.slice(0, MAX_BODY_TEXT_CHARS)
const vec = ((await extractor(input, { pooling: 'mean', normalize: true })) as { data: Float32Array }).data

const kw = extractKeywords(article.headline)
const nums = extractNumericTokens(article.headline)
const floor = defaultThresholds('local').lowConfidenceFloor
const now = Date.now()
const rows = blob.markets
  .filter((m) => m.embeddingB64 && !m.closed && !(m.endDate && Date.parse(m.endDate) < now))
  .map((m) => {
    const raw = cosineSimilarity(vec, b64ToFloatArray(m.embeddingB64!))
    const k = keywordOverlapBonus(kw, m.question)
    const n = numberOverlapScore(nums, m.question)
    const b = bracketScore(nums, m.question)
    const f = farFutureYearScore(`${article.headline} ${article.bodyText}`, m.question, now)
    const s = priceSubjectScore(`${article.headline} ${article.bodyText}`, m.question)
    const v = m.volume > 0 ? Math.min(0.015, 0.002 * Math.log10(m.volume)) : 0
    return { q: m.question, raw, k, n, b, f, s, v, score: raw + k + n + b + f + s + v, vol: m.volume }
  })
  .filter((r) => r.raw >= floor)
  .sort((a, b) => b.score - a.score)

console.log(`headline: ${article.headline}\nkeywords: ${[...kw].join(', ')} | numbers: ${[...nums].join(', ') || '-'}\n`)
const fmt = (r: (typeof rows)[number], i: number) =>
  `${String(i + 1).padStart(2)}. score ${r.score.toFixed(3)} = raw ${r.raw.toFixed(3)} + kw ${r.k.toFixed(2)} + num ${r.n.toFixed(2)} + bracket ${r.b.toFixed(2)} + year ${r.f.toFixed(2)} + subj ${r.s.toFixed(2)} + vol ${r.v.toFixed(3)}  $${Math.round(r.vol).toLocaleString('en')}  ${r.q}`
rows.slice(0, topN).forEach((r, i) => console.log(fmt(r, i)))
if (show) {
  console.log(`\nalso matching /${showArg}/:`)
  rows.forEach((r, i) => {
    if (i >= topN && show.test(r.q)) console.log(fmt(r, i))
  })
}
