/**
 * Compare embedding model quality on real Polymarket data for the Trump/Iran
 * article - which we know SHOULD rank "US x Iran permanent peace deal" as #1.
 */
import { pipeline, env } from '@xenova/transformers'

env.allowLocalModels = false
env.cacheDir = '/tmp/transformers-cache'

const WORKER_URL = process.env.WORKER_URL
const SECRET = process.env.WORKER_SECRET
if (!WORKER_URL || !SECRET) {
  console.error('Missing WORKER_URL or WORKER_SECRET env var. See .env.example.')
  process.exit(1)
}

const ARTICLE = {
  headline: 'Trump says he paused attack on Iran as negotiations continue',
  body: 'President Donald Trump said he had paused a planned military strike on Iran while diplomatic negotiations over the nuclear program continue. Iranian officials said they remained open to talks but warned of retaliation if attacked. The Strait of Hormuz remains tense.',
}

const MODELS = [
  'Xenova/all-MiniLM-L6-v2',
  'Xenova/all-MiniLM-L12-v2',
  'Xenova/bge-small-en-v1.5',
  'Xenova/multilingual-e5-small',
]

function cosine(a, b) {
  let d=0,ma=0,mb=0
  const n=Math.min(a.length,b.length)
  for(let i=0;i<n;i++){d+=a[i]*b[i];ma+=a[i]*a[i];mb+=b[i]*b[i]}
  const dn=Math.sqrt(ma)*Math.sqrt(mb)
  return dn===0?0:d/dn
}

async function fetchMarkets() {
  const out=[]; const seen=new Set()
  for (let i=0;i<3;i++) {
    const p=new URLSearchParams({active:'true',closed:'false',limit:'100',offset:String(i*100),order:'volumeNum',ascending:'false'})
    const r=await fetch(`${WORKER_URL}/markets?${p}`,{headers:{'X-Actually-Auth':SECRET}})
    const j=await r.json()
    for (const m of j) {
      if (!m.id||!m.question) continue
      const id=String(m.id); if (seen.has(id)) continue; seen.add(id)
      out.push(m)
    }
  }
  return out
}

const markets = await fetchMarkets()
console.log('Markets:', markets.length, '\n')

for (const modelId of MODELS) {
  process.stdout.write(`\n=== ${modelId} ===\n`)
  const t0=Date.now()
  let extractor
  try {
    // BGE/E5 models prefer specific prefixes for query vs passage. Skip for fairness here.
    extractor = await pipeline('feature-extraction', modelId)
  } catch (e) {
    console.log('  FAILED to load:', e.message)
    continue
  }
  console.log(`  loaded in ${((Date.now()-t0)/1000).toFixed(1)}s`)
  const t1=Date.now()
  const vecs=[]
  for (const m of markets) {
    const o=await extractor(m.question,{pooling:'mean',normalize:true})
    vecs.push(o.data)
  }
  console.log(`  embedded ${markets.length} markets in ${((Date.now()-t1)/1000).toFixed(1)}s`)

  const input = ARTICLE.headline+' '+ARTICLE.headline+' '+ARTICLE.body.slice(0,500)
  const av = (await extractor(input,{pooling:'mean',normalize:true})).data
  const scored = markets.map((m,i)=>({m,s:cosine(av,vecs[i])}))
  scored.sort((a,b)=>b.s-a.s)
  console.log('  Top 5 for Trump/Iran article:')
  for (let i=0;i<5;i++){
    const r=scored[i]
    console.log(`    ${r.s.toFixed(3)}  ${r.m.question}`)
  }
}
