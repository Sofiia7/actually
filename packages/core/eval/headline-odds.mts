/**
 * What do the markets say about these headlines? Runs each one through the
 * same findMatch the extension uses, against the LIVE cache, and prints the
 * featured market with its current price (fresh from Gamma via the worker,
 * cache price as fallback) plus the next alternatives. Content tool for
 * "headline vs odds" posts: every pair it prints is one the extension itself
 * would show for that text. Needs network and the local model, like
 * live-eval.mts.
 *
 *   npx tsx eval/headline-odds.mts <headlines.json>
 *
 * headlines.json is [{ "headline": ..., "bodyText"?: ..., "source"?: ... }].
 * Without bodyText the headline stands in for the body, as in live-eval.
 * The extension reads the whole article, so confirm a pair you plan to
 * publish on the real page (extension/scripts/promo-capture.mts).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultThresholds, fetchMarketById, findMatch, LOCAL_MODEL_ID, priceFromOutcomes } from '../src/index'
import type { CachedMarket, PolyMarket } from '../src/types'

interface HeadlineCase {
  headline: string
  bodyText?: string
  source?: string
}

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8')) as HeadlineCase[]

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const env = readFileSync(join(repoRoot, 'extension', '.env.local'), 'utf8')
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
const workerUrl = process.env.WORKER_URL || get('VITE_WORKER_URL')
const workerSecret = process.env.WORKER_SHARED_SECRET || get('VITE_WORKER_SECRET')
const res = await fetch(`${workerUrl}/market-cache`, { headers: { 'X-Actually-Auth': workerSecret } })
if (!res.ok) throw new Error(`market-cache fetch failed: ${res.status}`)
const blob = (await res.json()) as { builtAt: number; markets: CachedMarket[] }
const ageH = ((Date.now() - blob.builtAt) / 3_600_000).toFixed(1)
console.log(`cache: ${blob.markets.length} markets, built ${ageH}h ago\n`)

const { pipeline, env: tenv } = await import('@xenova/transformers')
tenv.allowLocalModels = false
const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
const embedder = {
  async embed(text: string): Promise<Float32Array> {
    return ((await extractor(text, { pooling: 'mean', normalize: true })) as { data: Float32Array }).data
  },
}
const store = { async getMarkets() { return blob.markets } }
const thresholds = defaultThresholds('local')

async function describe(m: PolyMarket): Promise<string> {
  const fresh = await fetchMarketById(m.id, workerUrl, workerSecret).catch(() => null)
  const p = priceFromOutcomes((fresh ?? m).outcomePrices, (fresh ?? m).outcomes)
  const price = Number.isFinite(p) ? `${Math.round(p * 100)}%${fresh ? '' : ' (cache)'}` : '?'
  const vol = `$${Math.round((fresh ?? m).volume).toLocaleString('en')}`
  const ends = m.endDate ? ` ends ${m.endDate.slice(0, 10)}` : ''
  return `${price}  vol ${vol}${ends}  "${m.question}"  polymarket.com/event/${m.eventSlug ?? m.slug}`
}

for (const c of cases) {
  console.log(`${c.source ? `[${c.source}] ` : ''}${c.headline}`)
  const m = await findMatch(c.headline, c.bodyText ?? c.headline, { store, embedder, thresholds })
  if (!m) {
    console.log('   NO MATCH\n')
    continue
  }
  console.log(`   ${m.lowConfidence ? 'LOW' : 'CONFIDENT'} raw=${m.confidence.toFixed(3)}  ${await describe(m.market)}`)
  for (const a of m.alternatives.slice(0, 3)) console.log(`   alt  ${await describe(a)}`)
  console.log()
}
