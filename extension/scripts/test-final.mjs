/**
 * Final calibration test: MiniLM-L12 + noise filtering + volume re-ranking.
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

const ARTICLES=[
  {n:'Trump/Iran',h:'Trump says he paused attack on Iran as negotiations continue',
   b:'President Donald Trump said he had paused a planned military strike on Iran while diplomatic negotiations over the nuclear program continue. Iranian officials said they remained open to talks but warned of retaliation if attacked. The Strait of Hormuz remains tense.'},
  {n:'Russia/Ukraine',h:'Putin and Zelensky meet in Istanbul for new round of ceasefire talks',
   b:'Russian President Vladimir Putin and Ukrainian President Volodymyr Zelensky met face-to-face in Istanbul as Turkey brokered another attempt at a ceasefire deal.'},
  {n:'Fed/recession',h:'Fed warns of recession risk as inflation persists above target',
   b:'The Federal Reserve raised concerns that the US economy could slip into recession in the coming year if inflation does not return to the 2% target.'},
  {n:'Bitcoin',h:'Bitcoin breaks $150,000 for the first time as ETF inflows surge',
   b:'Bitcoin pushed past $150,000 today in a record-setting rally driven by massive spot-ETF inflows and renewed institutional demand.'},
]

// Markets matching these regexes are word-association "games" rather than real
// outcome markets - they always dominate political news matches with high
// surface similarity but offer no real signal.
const NOISE_PATTERNS = [
  /\bwill\b.+\bsay\b\s*["']/i,
  /\bwill\b.+\bmention\b/i,
  /\bduring events with\b/i,
  /\bword of the (day|week)\b/i,
]
function isNoise(q){ return NOISE_PATTERNS.some(r => r.test(q)) }

function cosine(a,b){let d=0,ma=0,mb=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i++){d+=a[i]*b[i];ma+=a[i]*a[i];mb+=b[i]*b[i]}const dn=Math.sqrt(ma)*Math.sqrt(mb);return dn===0?0:d/dn}

async function fetchMarkets(){
  const out=[],seen=new Set()
  for(let i=0;i<3;i++){
    const p=new URLSearchParams({active:'true',closed:'false',limit:'100',offset:String(i*100),order:'volumeNum',ascending:'false'})
    const r=await fetch(`${WORKER_URL}/markets?${p}`,{headers:{'X-Actually-Auth':SECRET}})
    for(const m of await r.json()){
      if(!m.id||!m.question) continue
      const id=String(m.id); if(seen.has(id)) continue; seen.add(id)
      m.volume=Number(m.volumeNum??m.volume??0)
      out.push(m)
    }
  }
  return out
}

const markets=await fetchMarkets()
const clean = markets.filter(m=>!isNoise(m.question))
console.log(`Markets: ${markets.length} total, ${clean.length} after noise filter (${markets.length-clean.length} removed)\n`)

const extractor=await pipeline('feature-extraction','Xenova/all-MiniLM-L12-v2')
const vecs=[]
for(const m of clean){
  vecs.push((await extractor(m.question,{pooling:'mean',normalize:true})).data)
}

for(const a of ARTICLES){
  console.log(`\n=== ${a.n} ===`)
  const input=a.h+' '+a.h+' '+a.b.slice(0,500)
  const av=(await extractor(input,{pooling:'mean',normalize:true})).data
  const scored=clean.map((m,i)=>{
    const raw=cosine(av,vecs[i])
    const vb=m.volume>0?Math.min(0.015,0.002*Math.log10(m.volume)):0
    return{m,s:raw+vb,raw}
  })
  scored.sort((x,y)=>y.s-x.s)
  console.log('Top 5 (boosted score | raw similarity):')
  for(let i=0;i<5;i++){const r=scored[i]; console.log(`  ${r.s.toFixed(3)} | ${r.raw.toFixed(3)}  vol=$${Math.round(r.m.volume).toLocaleString().padStart(12)}  ${r.m.question}`)}
}
