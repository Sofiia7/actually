/**
 * Browser-level smoke for the packaged extension.
 *
 * Loads dist/ into a real installed Chromium browser (via playwright-core —
 * no browser download) the same way "Load unpacked" would, opens the popup
 * page, and walks all four tabs. Catches the class of "extension loads but
 * the popup white-screens / a tab crashes / the SW dies on startup"
 * regressions that neither unit tests nor the build-integrity smoke can see —
 * previously only caught by clicking through by hand.
 *
 * Default browser is Microsoft EDGE, not Chrome: branded Chrome 137+ silently
 * ignores --load-extension (verified here on Chrome 151 — the SW never
 * starts, headed or headless), while Edge (same Chromium, preinstalled on
 * every Windows 10/11) still honors it, including headless. Because dist/'s
 * manifest pins `key`, Edge assigns the exact production extension ID, so the
 * live Worker accepts this build's requests. On CI/macOS/Linux, install
 * "Chrome for Testing" or Playwright chromium and point --channel at it.
 *
 *   npm run build && npm run e2e          # headless Edge
 *   npm run e2e -- --headed               # watch it happen
 *   npm run e2e -- --channel chromium     # non-Windows fallback
 *
 * What fails the run:
 *   - extension service worker never starts
 *   - popup #root stays empty (white screen)
 *   - any uncaught exception (pageerror) in the popup, on load or per tab
 *   - a tab button missing, or clicking it empties the UI
 *   - a console error that is not a plain network failure (network errors to
 *     the Worker/CLOB are reported as warnings — this smoke must also pass
 *     offline, matching the popup's own offline-tolerant design)
 *
 * Exit 0 = pass, 1 = checks failed, 2 = no build / no Chrome to run against.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const DIST = resolve('dist')
const TABS = ['Check', 'Trade', 'History', 'Settings']
const HEADED = process.argv.includes('--headed')
const CHANNEL = process.argv.includes('--channel')
  ? process.argv[process.argv.indexOf('--channel') + 1]
  : 'msedge'

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  console.error(`  ✗ ${m}`)
  failures++
}
const warn = (m) => console.log(`  ~ ${m}`)

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/manifest.json — run `npm run build` first.')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'actually-e2e-'))
let context
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: CHANNEL,
    headless: !HEADED,
    viewport: { width: 420, height: 640 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
  })
} catch (err) {
  console.error(`Could not launch browser channel "${CHANNEL}": ${err.message}`)
  console.error('Try `npm run e2e -- --channel chromium` or `-- --headed`.')
  process.exit(2)
}

console.log(`E2E smoke on dist/ (${HEADED ? 'headed' : 'headless'} ${CHANNEL}):`)

try {
  // 1. The MV3 service worker must come up — its absence means Chrome
  // rejected the extension outright (manifest/CSP/bundle problem).
  let sw = context.serviceWorkers()[0]
  if (!sw) {
    sw = await context
      .waitForEvent('serviceworker', { timeout: 15_000 })
      .catch(() => null)
  }
  if (!sw) {
    bad('extension service worker never started (Chrome refused the unpacked dist/?)')
    throw new Error('no service worker')
  }
  const extensionId = new URL(sw.url()).host
  ok(`service worker up (extension id ${extensionId})`)

  // 2. Open the popup page the way the toolbar click would.
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

  // 3. React must actually mount something.
  await page
    .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, {
      timeout: 10_000,
    })
    .catch(() => {})
  const rootChildren = await page.evaluate(
    () => document.getElementById('root')?.childElementCount ?? 0,
  )
  rootChildren > 0
    ? ok('popup mounted (#root has content)')
    : bad('popup white-screened (#root empty after 10s)')

  // 4. Walk every tab; each click must neither crash nor empty the UI.
  for (const tab of TABS) {
    const btn = page.getByRole('button', { name: tab, exact: true })
    if ((await btn.count()) === 0) {
      bad(`tab button "${tab}" not found`)
      continue
    }
    const errorsBefore = pageErrors.length
    await btn.first().click()
    await page.waitForTimeout(400) // let effects/fetches settle
    const alive = await page.evaluate(
      () => (document.getElementById('root')?.innerText ?? '').trim().length > 0,
    )
    if (!alive) bad(`tab "${tab}": UI went blank after switching`)
    else if (pageErrors.length > errorsBefore)
      bad(`tab "${tab}": uncaught exception — ${pageErrors[pageErrors.length - 1]}`)
    else ok(`tab "${tab}" renders`)
  }

  // 5. Live match pipeline, end to end: send the same OS_RUN_MATCH message
  // the Check button sends (popup -> SW -> offscreen document -> Worker
  // market-cache fetch with the baked-in secret -> bundled WASM embedding ->
  // matcher). This is the "открыла попап, нажала Check — и ничего не
  // произошло" flow. A match and a clean no-match both PASS (matching
  // quality is not a smoke concern); a transport/auth/cache/model error
  // FAILS. Skipped with --offline.
  if (!process.argv.includes('--offline')) {
    const matchRes = await page
      .evaluate(
        (article) =>
          Promise.race([
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'OS_RUN_MATCH', article }),
            new Promise((r) => setTimeout(() => r({ type: 'E2E_TIMEOUT' }), 90_000)),
          ]),
        {
          headline: 'Fed expected to cut interest rates at the September FOMC meeting',
          bodyText:
            'The Federal Reserve is widely expected to lower its benchmark ' +
            'interest rate when policymakers meet in September, as inflation ' +
            'cools and the labor market softens.',
          url: 'https://example.com/fed-rate-cut',
          domain: 'example.com',
        },
      )
      .catch((e) => ({ type: 'E2E_EVAL_ERROR', error: String(e) }))
    if (matchRes?.type === 'OS_MATCH_RESULT') {
      if (matchRes.match) ok(`live match pipeline works (matched: "${String(matchRes.match.market?.question ?? '').slice(0, 60)}" @ ${Math.round((matchRes.match.probability ?? 0) * 100)}%)`)
      else if (String(matchRes.reason ?? '').startsWith('below_floor')) ok(`live match pipeline works (clean no-match: ${String(matchRes.reason).slice(0, 80)})`)
      else if (matchRes.reason) bad(`match pipeline returned error reason: ${matchRes.reason}`)
      else ok('live match pipeline works (clean no-match)')
    } else if (matchRes?.type === 'E2E_TIMEOUT') {
      bad('match pipeline did not answer within 90s (offscreen/model/worker hang)')
    } else if (matchRes?.type === 'OS_ERROR') {
      bad(`match pipeline OS_ERROR: ${matchRes.error}`)
    } else {
      bad(`match pipeline unexpected response: ${JSON.stringify(matchRes)?.slice(0, 200)}`)
    }
  } else {
    warn('live match pipeline skipped (--offline)')
  }

  // 6. Uncaught exceptions anywhere along the way are always failures.
  if (pageErrors.length > 0) {
    for (const e of pageErrors) bad(`uncaught popup exception: ${e}`)
  } else {
    ok('no uncaught popup exceptions')
  }

  // 7. Console errors: real network failures (Worker/CLOB unreachable, geo
  // probe offline, ...) are warnings — everything else fails the run.
  const NETWORKY = /net::ERR_|Failed to fetch|ERR_INTERNET_DISCONNECTED|status of (4|5)\d\d/
  for (const e of consoleErrors) {
    NETWORKY.test(e) ? warn(`network console error (tolerated): ${e.slice(0, 160)}`) : bad(`console error: ${e.slice(0, 300)}`)
  }
  if (consoleErrors.length === 0) ok('no console errors')
} catch (err) {
  if (err.message !== 'no service worker') bad(`e2e crashed: ${err.stack ?? err}`)
} finally {
  await context.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
}

console.log(failures ? `\nE2E SMOKE FAILED (${failures} issue${failures > 1 ? 's' : ''})` : '\nE2E SMOKE PASSED')
process.exit(failures ? 1 : 0)
