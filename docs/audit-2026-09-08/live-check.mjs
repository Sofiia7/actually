import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Read only the public client configuration. Never print tokens or wallet data.
const envText = readFileSync('extension/.env.local', 'utf8')
function value(name) {
  const line = envText.split(/\r?\n/).find((line) => line.startsWith(name + '='))
  return line?.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '')
}
const base = value('VITE_WORKER_URL')?.replace(/\/$/, '')
const token = value('VITE_WORKER_SECRET')
if (!base || !token) throw new Error('Missing public Worker client configuration')
const reports = []
for (const path of ['/health', '/builder-status', '/market-cache']) {
  try {
    const started = Date.now()
    const res = await fetch(base + path, {
      headers: { 'X-Actually-Auth': token }, signal: AbortSignal.timeout(20000),
    })
    const data = await res.json()
    const report = { path, status: res.status, elapsedMs: Date.now() - started }
    if (path === '/health') report.ok = data.ok === true
    if (path === '/builder-status') Object.assign(report, { configured: data.configured, mode: data.mode })
    if (path === '/market-cache' && Array.isArray(data.markets)) {
      Object.assign(report, {
        model: data.model, count: data.markets.length,
        builtAt: new Date(data.builtAt).toISOString(), ageHours: (Date.now() - data.builtAt) / 3600000,
        closedOrExpired: data.markets.filter(m => m.closed || (m.endDate && Date.parse(m.endDate) < Date.now())).length,
      })
      mkdirSync('docs/audit-2026-09-08/.scratch', { recursive: true })
      writeFileSync('docs/audit-2026-09-08/.scratch/live-cache.json.log', JSON.stringify(data))
    }
    reports.push(report)
  } catch (error) { reports.push({ path, error: error.name + ': ' + error.message }) }
}
writeFileSync(resolve('docs/audit-2026-09-08/live-check.json'), JSON.stringify(reports, null, 2))
console.log(JSON.stringify(reports, null, 2))
