/**
 * Offline matching test — runs transformers.js in Node against real markets
 * fetched from the production Worker. Lets us iterate on matching quality
 * without rebuilding/reloading the extension every time.
 *
 * Usage:
 *   WORKER_URL=https://... WORKER_SECRET=... node scripts/test-match.mjs
 *   (or put both in .env.local — see .env.example)
 */
import { pipeline, env } from '@xenova/transformers'

const WORKER_URL = process.env.WORKER_URL
const SECRET = process.env.WORKER_SECRET
if (!WORKER_URL || !SECRET) {
  console.error('Missing WORKER_URL or WORKER_SECRET env var. See .env.example.')
  process.exit(1)
}
const LIMIT = 300

env.allowLocalModels = false
env.cacheDir = '/tmp/transformers-cache'

// Some test news articles (headline + body excerpt)
const TEST_ARTICLES = [
  {
    name: 'Trump pauses Iran attack',
    headline: 'Trump says he paused attack on Iran as negotiations continue',
    body: 'President Donald Trump said he had paused a planned military strike on Iran while diplomatic negotiations over the nuclear program continue. Iranian officials said they remained open to talks but warned of retaliation if attacked. The Strait of Hormuz remains tense.',
  },
  {
    name: 'Russia-Ukraine ceasefire talks',
    headline: 'Putin and Zelensky meet in Istanbul for new round of ceasefire talks',
    body: 'Russian President Vladimir Putin and Ukrainian President Volodymyr Zelensky met face-to-face in Istanbul as Turkey brokered another attempt at a ceasefire deal. The war has dragged on for over four years with no clear end in sight.',
  },
  {
    name: 'US recession warning',
    headline: 'Fed warns of recession risk as inflation persists above target',
    body: 'The Federal Reserve raised concerns that the US economy could slip into recession in the coming year if inflation does not return to the 2% target. Markets sold off on the news.',
  },
  {
    name: 'Bitcoin all-time high',
    headline: 'Bitcoin breaks $150,000 for the first time as ETF inflows surge',
    body: 'Bitcoin pushed past $150,000 today in a record-setting rally driven by massive spot-ETF inflows and renewed institutional demand. Crypto sentiment is at an all-time high.',
  },
]

function cosine(a, b) {
  let d = 0, ma = 0, mb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i] }
  const denom = Math.sqrt(ma) * Math.sqrt(mb)
  return denom === 0 ? 0 : d / denom
}

async function fetchMarkets() {
  const out = []
  const seen = new Set()
  const pages = Math.ceil(LIMIT / 100)
  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams({
      active: 'true', closed: 'false', limit: '100', offset: String(i * 100),
      order: 'volumeNum', ascending: 'false',
    })
    const r = await fetch(`${WORKER_URL}/markets?${params}`, {
      headers: { 'X-Actually-Auth': SECRET },
    })
    if (!r.ok) throw new Error(`markets ${r.status}`)
    const j = await r.json()
    if (j.length === 0) break
    for (const m of j) {
      if (!m.id || !m.question || !m.outcomePrices || !m.outcomes) continue
      const id = String(m.id)
      if (seen.has(id)) continue
      seen.add(id)
      m.volume = Number(m.volumeNum ?? m.volume ?? 0)
      out.push(m)
      if (out.length >= LIMIT) return out
    }
  }
  return out
}

function priceYes(outcomePrices) {
  try { return parseFloat(JSON.parse(outcomePrices)[0]) } catch { return NaN }
}

const t0 = Date.now()
console.log('Loading model...')
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
console.log('Model loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's')

console.log('Fetching markets...')
const markets = await fetchMarkets()
console.log('Markets:', markets.length)

console.log('Embedding market questions...')
const t1 = Date.now()
const marketVecs = []
for (let i = 0; i < markets.length; i++) {
  const out = await extractor(markets[i].question, { pooling: 'mean', normalize: true })
  marketVecs.push(out.data)
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${markets.length}`)
}
console.log('Embedded in', ((Date.now() - t1) / 1000).toFixed(1), 's')

for (const article of TEST_ARTICLES) {
  console.log('\n' + '='.repeat(80))
  console.log('Article:', article.name)
  console.log('  ' + article.headline)
  const input = article.headline + ' ' + article.headline + ' ' + article.body.slice(0, 500)
  const out = await extractor(input, { pooling: 'mean', normalize: true })
  const av = out.data
  const scored = markets.map((m, i) => ({ m, score: cosine(av, marketVecs[i]) }))
  scored.sort((a, b) => b.score - a.score)
  console.log('  Top 8 matches:')
  for (let i = 0; i < 8; i++) {
    const r = scored[i]
    const yes = priceYes(r.m.outcomePrices)
    const yesPct = Number.isFinite(yes) ? `${Math.round(yes * 100)}%` : '?'
    console.log(
      `    ${(r.score).toFixed(3)}  YES=${yesPct.padStart(4)}  vol=$${Math.round(r.m.volume).toLocaleString().padStart(12)}  ${r.m.question}`,
    )
  }
}

console.log('\nDone.')
