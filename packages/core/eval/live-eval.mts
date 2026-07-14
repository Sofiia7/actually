/**
 * Live matching-quality eval. NOT a unit test — it needs network (the
 * worker's /market-cache blob) and the local MiniLM model, so it runs on
 * demand, not in CI:
 *
 *   npm run eval:matching -w @actually/core
 *
 * Worker credentials come from WORKER_URL / WORKER_SHARED_SECRET env vars,
 * falling back to extension/.env.local (the dev setup that always exists on
 * the machine this runs on).
 *
 * Each case pins a headline to an expectation against the LIVE market cache.
 * Expectations are deliberately loose regexes — the cache's exact contents
 * drift as markets open and close, so we assert "a market about X", not a
 * specific market id. When the pool genuinely lacks a right market, the
 * correct behavior is no confident match, hence `none` / `not` cases.
 *
 * History: built 2026-07-13 after live junk matches were found (BTC $120k
 * headline → "dip to $57,500" CONFIDENT; Taylor Swift album → Rihanna album
 * card; war articles historically matched Putin-leadership markets when the
 * cache was 300 markets deep). Guards against those regressing silently.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { findMatch, defaultThresholds, LOCAL_MODEL_ID } from '../src/index'
import type { CachedMarket } from '../src/types'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function workerCreds(): { url: string; secret: string } {
  let url = process.env.WORKER_URL ?? ''
  let secret = process.env.WORKER_SHARED_SECRET ?? ''
  if (!url || !secret) {
    const env = readFileSync(join(repoRoot, 'extension', '.env.local'), 'utf8')
    const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
    url = url || get('VITE_WORKER_URL')
    secret = secret || get('VITE_WORKER_SECRET')
  }
  if (!url || !secret) throw new Error('set WORKER_URL/WORKER_SHARED_SECRET or fill extension/.env.local')
  return { url, secret }
}

interface EvalCase {
  name: string
  text: string
  /** 'confident' = top match must hit `expect` and not be lowConfidence.
   *  'top3'      = `expect` must appear in top match or first 3 alternatives.
   *  'none'      = no match at all (below floor).
   *  'not'       = whatever matches, the top match must NOT hit `reject` as CONFIDENT. */
  kind: 'confident' | 'top3' | 'none' | 'not'
  expect?: RegExp
  reject?: RegExp
}

const CASES: EvalCase[] = [
  {
    name: 'Fed July meeting',
    text: 'Fed expected to cut interest rates at its July meeting as inflation cools',
    kind: 'confident',
    expect: /fed .*(rate|bps)|interest rates/i,
  },
  {
    name: 'Bitcoin $120k — must not pick a conflicting price level',
    text: 'Bitcoin climbs above $120,000 as spot ETF inflows accelerate',
    kind: 'confident',
    expect: /bitcoin.*120,000/i,
  },
  {
    name: 'Iran nuclear talks',
    text: 'Iran signals readiness to resume nuclear negotiations with the United States',
    kind: 'confident',
    expect: /iran.*(nuclear|negotiat|deal)|nuclear.*iran/i,
  },
  {
    name: 'Ukraine ceasefire talks (headline)',
    text: 'Zelensky says ceasefire negotiations with Russia have stalled again',
    kind: 'confident',
    expect: /ceasefire|peace deal/i,
  },
  {
    name: 'Ukraine war (article-length) — regression: must not match Putin-leadership/election',
    text:
      'Russian forces launched one of the largest drone and missile attacks on Kyiv in months, ' +
      'killing at least 12 people and damaging residential buildings. Ukrainian officials said air ' +
      'defenses intercepted dozens of drones as the war grinds into another summer.',
    kind: 'not',
    reject: /putin.*(out|leader|president|election)|election.*putin/i,
  },
  {
    name: 'World Cup final',
    text: 'France defeats Spain to reach the 2026 World Cup final',
    kind: 'confident',
    expect: /france.*(final|world cup)/i,
  },
  {
    name: 'Apple AI event — no Apple market exists; xAI/OpenAI junk must not be CONFIDENT',
    text: 'Apple unveils new AI features for iPhone at its developer event',
    kind: 'not',
    reject: /xai|openai|google/i,
  },
  {
    name: 'Off-topic English',
    text: 'Scientists discover new deep-sea fish species off the coast of Japan',
    kind: 'none',
  },
  {
    name: 'Off-topic Russian',
    text: 'Местные власти Казани отчитались о ремонте дорог во дворах',
    kind: 'none',
  },
  {
    name: 'Taylor Swift album — Rihanna-album market must not be CONFIDENT',
    text: 'Taylor Swift announces a new album release date',
    kind: 'not',
    reject: /rihanna|carti|drake/i,
  },
]

const { url, secret } = workerCreds()
const res = await fetch(`${url}/market-cache`, { headers: { 'X-Actually-Auth': secret } })
if (!res.ok) throw new Error(`market-cache fetch failed: ${res.status}`)
const blob = (await res.json()) as { model: string; builtAt: number; markets: CachedMarket[] }
const ageH = ((Date.now() - blob.builtAt) / 3_600_000).toFixed(1)
console.log(`cache: ${blob.markets.length} markets, model=${blob.model}, built ${ageH}h ago\n`)

const { pipeline, env } = await import('@xenova/transformers')
env.allowLocalModels = false
const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
const embedder = {
  async embed(text: string): Promise<Float32Array> {
    const out = (await extractor(text, { pooling: 'mean', normalize: true })) as { data: Float32Array }
    return out.data
  },
}
const store = { async getMarkets() { return blob.markets } }
const thresholds = defaultThresholds('local')

let failed = 0
for (const c of CASES) {
  const m = await findMatch(c.text, c.text, { store, embedder, thresholds })
  const desc = m
    ? `raw=${m.confidence.toFixed(3)} ${m.lowConfidence ? 'LOW' : 'CONFIDENT'} -> "${m.market.question}"`
    : 'NO MATCH'
  let ok: boolean
  switch (c.kind) {
    case 'none':
      ok = m === null
      break
    case 'confident':
      ok = !!m && !m.lowConfidence && c.expect!.test(m.market.question)
      break
    case 'top3':
      ok = !!m && [m.market, ...m.alternatives.slice(0, 3)].some((x) => c.expect!.test(x.question))
      break
    case 'not':
      ok = !m || m.lowConfidence || !c.reject!.test(m.market.question)
      break
  }
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.name}]`)
  console.log(`      ${desc}`)
  if (m && m.alternatives.length > 0) {
    console.log(`      alts: ${m.alternatives.slice(0, 3).map((a) => a.question).join(' | ')}`)
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`)
if (failed > 0) process.exitCode = 1
