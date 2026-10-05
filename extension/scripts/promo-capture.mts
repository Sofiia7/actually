/**
 * Promo capture: a real match on a real, current article, for marketing GIFs
 * and store screenshots - so promo material never shows a market that has
 * already resolved.
 *
 * Loads dist/ into headless Edge (the manifest key gives it the production
 * ID, so the live Worker answers), opens the article, and drives the popup
 * through its own Check flow: local model, Worker, market cache and matcher
 * are all real. Only the tab plumbing is stood in for. A popup opened as a
 * page is its own active tab and holds no activeTab grant for the article, so
 * it is handed the article the extension's own extractor reads from the
 * article tab - exactly what executeScript would have returned.
 *
 *   npm run build
 *   npx tsx scripts/promo-capture.mts <article-url> <out-dir>
 *
 * Writes article.png (1280x800, page only), popup-idle.png,
 * popup-loading.png and popup-result.png (360px wide, the real popup width),
 * plus article.json and popup-result.txt to check what was matched.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { extractFromPage } from '../src/background/extractor'

const [url, outArg] = process.argv.slice(2)
if (!url) {
  console.error('usage: npx tsx scripts/promo-capture.mts <article-url> <out-dir>')
  process.exit(2)
}
const OUT = resolve(outArg ?? 'promo-out')
const DIST = resolve(import.meta.dirname, '..', 'dist')
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No dist/manifest.json - run `npm run build` first.')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

// Fixed-position overlays (consent walls, subscription nags, sticky ad bars)
// are hidden for the shot rather than clicked: nothing is accepted or
// declined on anyone's behalf, they are just not in the picture.
// A site header pinned to the top stays; anything else fixed (a modal, its
// dimming backdrop, a bottom bar) goes, unless it holds the headline itself.
const HIDE_OVERLAYS = `(() => {
  const headline = document.querySelector('h1')
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    if (s.position !== 'fixed' && s.position !== 'sticky') continue
    if (headline && el.contains(headline)) continue
    const r = el.getBoundingClientRect()
    if (r.top > 120 || r.height > 140) el.style.setProperty('display', 'none', 'important')
  }
  for (const el of [document.documentElement, document.body]) el.style.setProperty('overflow', 'auto', 'important')
})()`

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'actually-promo-')), {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
})

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }))
  const extensionId = new URL(sw.url()).host
  console.log(`extension ${extensionId}`)

  const article = await context.newPage()
  await article.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await article.waitForTimeout(6_000)
  await article.evaluate(HIDE_OVERLAYS)
  await article.evaluate('window.scrollTo(0, 0)')
  await article.waitForTimeout(800)
  // tsx may wrap functions in its __name helper; give the page a no-op one.
  await article.evaluate('window.__name = window.__name || ((f) => f)')
  const data = (await article.evaluate(`(${extractFromPage.toString()})()`)) as {
    headline?: string
    bodyText?: string
  } | null
  if (!data?.headline) throw new Error('extractor found no article on the page')
  console.log(`article: ${data.headline}`)
  writeFileSync(join(OUT, 'article.json'), JSON.stringify(data, null, 2))
  await article.screenshot({ path: join(OUT, 'article.png') })

  const popup = await context.newPage()
  await popup.setViewportSize({ width: 360, height: 600 })
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await popup.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0)
  await popup.evaluate((art) => {
    const c = chrome as unknown as {
      tabs: { query: unknown }
      scripting: { executeScript: unknown }
    }
    c.tabs.query = async () => [{ id: 4242, url: (art as { url?: string }).url, active: true }]
    c.scripting.executeScript = async () => [{ result: art }]
  }, data)
  await popup.waitForTimeout(1_000)
  await popup.screenshot({ path: join(OUT, 'popup-idle.png') })

  await popup.getByRole('button', { name: /check this page/i }).click()
  await popup.waitForTimeout(300)
  await popup.screenshot({ path: join(OUT, 'popup-loading.png') })
  await popup.waitForFunction(() => /market odds|no market|nothing on polymarket/i.test(document.body.innerText), null, {
    timeout: 120_000,
  })
  await popup.waitForTimeout(1_500)
  await popup.screenshot({ path: join(OUT, 'popup-result.png') })
  const text = await popup.evaluate(() => document.body.innerText)
  writeFileSync(join(OUT, 'popup-result.txt'), text)
  console.log(text.split('\n').filter(Boolean).slice(0, 14).join(' | '))
} finally {
  await context.close()
}
