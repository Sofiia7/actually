/**
 * Fetch every .woff2 subset required by src/popup_new/fonts.css from
 * Google Fonts and save them under public/fonts/.
 *
 *   npm run fonts:fetch
 *
 * We resolve the canonical URLs through the CSS2 stylesheet endpoint
 * (rather than hardcoding woff2 paths) so font version bumps don't
 * silently 404 us. The files are then bundled into the .crx - nothing
 * fetched at runtime.
 *
 * IMPORTANT: Google's CSS2 response contains one @font-face block PER
 * SUBSET (cyrillic, latin, ...), each with its own woff2 URL and
 * unicode-range. Downloading only the first block ships a font that
 * covers only that subset's characters - this exact bug shipped a
 * cyrillic-only Marck Script until 2026-08-02, so every Latin string in
 * the popup silently fell back to the system cursive font (Comic Sans
 * on Windows). All subsets must be fetched, and fonts.css must declare
 * one @font-face per subset with the matching unicode-range (printed by
 * this script on every run for easy copy-paste).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '..', 'public', 'fonts')

const FONT = {
  family: 'Marck Script',
  outPrefix: 'MarckScript-Regular',
  cssUrl:
    'https://fonts.googleapis.com/css2?family=Marck+Script&display=swap',
}

await mkdir(OUT_DIR, { recursive: true })

// Google's CSS2 endpoint returns different URLs per user-agent. Spoofing a
// modern Chrome string yields the woff2 variants we want.
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

// One block per subset: "/* latin */ @font-face { ... url(...woff2) ...
// unicode-range: ...; }". Capture the subset label, the woff2 URL, and the
// unicode-range so fonts.css can be kept in sync.
const blockRe =
  /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)[^}]*?unicode-range:\s*([^;]+);[^}]*\}/g
const subsets = [...css.matchAll(blockRe)].map(([, label, url, range]) => ({
  label,
  url,
  range: range.trim(),
}))

if (subsets.length === 0) {
  console.error('No woff2 subset blocks found in Google CSS response.')
  console.error(css.slice(0, 500))
  process.exit(1)
}
if (!subsets.some((s) => s.label === 'latin')) {
  console.error(
    `Subsets returned (${subsets.map((s) => s.label).join(', ')}) do not ` +
      'include "latin" - refusing to write a font set that cannot render ' +
      "the extension's own UI strings.",
  )
  process.exit(1)
}

for (const s of subsets) {
  const out = `${FONT.outPrefix}-${s.label}.woff2`
  process.stdout.write(`- ${out} ... `)
  const res = await fetch(s.url)
  if (!res.ok) {
    console.error(`FAILED (${res.status})`)
    process.exit(1)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  await writeFile(resolve(OUT_DIR, out), buf)
  console.log(`ok (${buf.byteLength} bytes)`)
}

console.log(`\nDone. Wrote ${subsets.length} subset files to public/fonts/.`)
console.log(
  'Keep src/popup_new/fonts.css in sync - one @font-face per subset:\n',
)
for (const s of subsets) {
  console.log(`/* ${s.label} */
@font-face {
  font-family: '${FONT.family}';
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  src: url('/public/fonts/${FONT.outPrefix}-${s.label}.woff2') format('woff2');
  unicode-range: ${s.range};
}
`)
}
