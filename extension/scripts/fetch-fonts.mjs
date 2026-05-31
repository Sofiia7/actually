/**
 * Fetch the single .woff2 file required by src/popup_new/fonts.css from
 * Google Fonts and save it under public/fonts/.
 *
 *   npm run fonts:fetch
 *
 * We resolve the canonical URL through the CSS2 stylesheet endpoint
 * (rather than hardcoding the woff2 path) so font version bumps don't
 * silently 404 us. The file is then bundled into the .crx — nothing
 * fetched at runtime.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '..', 'public', 'fonts')

const FONT = {
  family: 'Marck Script',
  out: 'MarckScript-Regular.woff2',
  cssUrl:
    'https://fonts.googleapis.com/css2?family=Marck+Script&display=swap',
}

await mkdir(OUT_DIR, { recursive: true })

// Google's CSS2 endpoint returns different URLs per user-agent. Spoofing a
// modern Chrome string yields the woff2 variant we want.
const cssRes = await fetch(FONT.cssUrl, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  },
})
if (!cssRes.ok) {
  console.error(`CSS fetch failed (${cssRes.status})`)
  process.exit(1)
}
const css = await cssRes.text()
const m = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)
if (!m) {
  console.error('No woff2 URL found in Google CSS response.')
  console.error(css.slice(0, 500))
  process.exit(1)
}

process.stdout.write(`- ${FONT.out} ... `)
const res = await fetch(m[1])
if (!res.ok) {
  console.error(`FAILED (${res.status})`)
  process.exit(1)
}
const buf = new Uint8Array(await res.arrayBuffer())
await writeFile(resolve(OUT_DIR, FONT.out), buf)
console.log(`ok (${buf.byteLength} bytes)`)
console.log(`\nDone. Wrote ${FONT.out} to public/fonts/`)
