/**
 * Release pre-flight: verify the built dist/ before uploading to the Chrome
 * Web Store. Run after `npm run build`:
 *
 *   npm run build && npm run preflight
 *
 * Checks:
 *   - dist/manifest.json exists and has a version
 *   - CSP connect-src has no `*.workers.dev` wildcard (prod must pin one origin)
 *   - host_permissions is exactly the single CLOB host
 *   - no known-burned secret is baked into any shipped file
 *
 * Exit code 0 = pass, 1 = checks failed, 2 = no build to check.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
// The v2.0 secret that was once committed — treated as public forever.
const BURNED_SECRET = '770d0e45222c7fba195e27da296141a2d1be288120e503ee3161a041642e1f6b'

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  console.error(`  ✗ ${m}`)
  failures++
}

let manifest
try {
  manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
} catch {
  console.error('No dist/manifest.json — run `npm run build` first.')
  process.exit(2)
}

console.log('Pre-flight checks on dist/:')

manifest.version ? ok(`manifest version ${manifest.version}`) : bad('manifest.version missing')

const csp = manifest.content_security_policy?.extension_pages ?? ''
if (csp.includes('*.workers.dev')) {
  bad('CSP still contains a *.workers.dev wildcard — set VITE_WORKER_URL for the prod build')
} else {
  ok('CSP has no *.workers.dev wildcard')
}

const hp = JSON.stringify(manifest.host_permissions ?? [])
if (hp === JSON.stringify(['https://clob.polymarket.com/*'])) {
  ok('host_permissions = ["https://clob.polymarket.com/*"]')
} else {
  bad(`host_permissions unexpected: ${hp}`)
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

let leaked = false
for (const f of walk(DIST)) {
  if (!/\.(js|mjs|json|html|css|map)$/.test(f)) continue
  if (readFileSync(f, 'utf8').includes(BURNED_SECRET)) {
    bad(`burned secret found in ${f}`)
    leaked = true
  }
}
if (!leaked) ok('no burned secret baked into dist')

console.log(failures ? `\nPRE-FLIGHT FAILED (${failures} issue${failures > 1 ? 's' : ''})` : '\nPRE-FLIGHT PASSED')
process.exit(failures ? 1 : 0)
