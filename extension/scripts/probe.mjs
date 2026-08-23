/**
 * Quick probe of the production Worker `/markets` endpoint. Useful for
 * one-off market inspection from the terminal.
 *
 * Usage:
 *   WORKER_URL=https://... WORKER_SECRET=... EXTENSION_ID=... node scripts/probe.mjs
 *
 * Reads secrets from env - never hardcode them here. See .env.example.
 */
const SECRET = process.env.WORKER_SECRET
const URL_BASE = process.env.WORKER_URL
const EXTENSION_ID = process.env.EXTENSION_ID

if (!SECRET || !URL_BASE) {
  console.error('Missing env: set WORKER_URL and WORKER_SECRET (see .env.example).')
  process.exit(1)
}

const headers = { 'X-Actually-Auth': SECRET }
if (EXTENSION_ID) headers.Origin = `chrome-extension://${EXTENSION_ID}`

const all = []
for (let i = 0; i < 3; i++) {
  const r = await fetch(
    `${URL_BASE}/markets?active=true&closed=false&limit=100&offset=${i * 100}&order=volumeNum&ascending=false`,
    { headers },
  )
  if (!r.ok) {
    console.log('ERR', r.status, await r.text())
    process.exit(1)
  }
  const d = await r.json()
  all.push(...d)
}
console.log('total fetched:', all.length)
const re = /iran|tehran|khamenei|israel|hezbollah|middle east|nuclear/i
const hits = all.filter((m) => re.test((m.question || '') + ' ' + (m.description || '')))
console.log('geopolitical-hits:', hits.length)
hits.slice(0, 15).forEach((m) =>
  console.log(' -', m.question, '| vol=', Math.round(Number(m.volumeNum || 0))),
)
console.log('\nTop 5 by volume overall:')
all.slice(0, 5).forEach((m) =>
  console.log(' -', m.question, '| vol=', Math.round(Number(m.volumeNum || 0))),
)
