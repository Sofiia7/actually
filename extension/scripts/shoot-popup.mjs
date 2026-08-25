/**
 * Screenshot the real popup out of dist/, for looking at the chrome rather
 * than testing behaviour.
 *
 *   node scripts/shoot-popup.mjs [outfile.png]
 *
 * Same launch path as e2e-smoke.mjs (Edge, unpacked dist/), because that is
 * the only way to render the popup with its own extension origin, storage and
 * generated frost texture. Anything else is a mock of the thing being judged.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const DIST = resolve('dist')
const OUT = resolve(process.argv[2] ?? 'popup-shot.png')
const CHANNEL = process.argv.includes('--channel')
  ? process.argv[process.argv.indexOf('--channel') + 1]
  : 'msedge'

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/manifest.json - run `npm run build` first.')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'actually-shot-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: CHANNEL,
  headless: true,
  viewport: { width: 420, height: 660 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
})

try {
  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await page.waitForSelector('#root > *', { timeout: 15_000 })
  // The frost texture is painted to a canvas and cached; give it a beat to
  // land before the shutter.
  await page.waitForTimeout(1500)
  await page.screenshot({ path: OUT })
  console.log(`wrote ${OUT}`)
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
