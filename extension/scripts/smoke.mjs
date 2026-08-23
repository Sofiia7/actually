/**
 * Build-integrity smoke for the packaged extension.
 *
 * Browser-free: it loads dist/ the way Chrome would and asserts every file the
 * manifest (and the popup / offscreen HTML) references actually exists and is
 * non-empty. Catches the class of "build emitted a broken or partial bundle"
 * regressions that unit tests can't see - without needing a headed Chromium.
 * The human click-through smoke stays in docs/release-checklist.md.
 *
 *   npm run build && npm run smoke
 *
 * Exit 0 = pass, 1 = checks failed, 2 = no build to check.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DIST = 'dist'
let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  console.error(`  ✗ ${m}`)
  failures++
}

/** True only if the path exists under dist/ and is non-empty. */
function exists(rel) {
  const p = join(DIST, rel)
  return existsSync(p) && statSync(p).size > 0
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

let manifest
try {
  manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
} catch {
  console.error('No dist/manifest.json - run `npm run build` first.')
  process.exit(2)
}

console.log('Smoke checks on dist/:')

// 1. Service worker entry exists.
const sw = manifest.background?.service_worker
sw && exists(sw) ? ok(`service worker present (${sw})`) : bad(`service worker missing: ${sw}`)

// 2. Popup HTML exists.
const popup = manifest.action?.default_popup
popup && exists(popup) ? ok(`popup html present (${popup})`) : bad(`popup html missing: ${popup}`)

// 3. Offscreen HTML exists (created at runtime via chrome.offscreen, so it is
//    not in the manifest - but the build must still emit it at this path).
const offscreen = 'src/offscreen/offscreen.html'
exists(offscreen) ? ok('offscreen html present') : bad(`offscreen html missing: ${offscreen}`)

// 4. Every icon the manifest references is present.
const icons = Object.values(manifest.icons ?? {})
let iconsOk = icons.length > 0
for (const ic of icons) if (!exists(ic)) iconsOk = false
iconsOk ? ok(`icons present (${icons.length})`) : bad('one or more manifest icons missing')

// 5. Every url() reference in shipped CSS resolves to a bundled file.
// (Generalizes the old "a woff2 must exist" check from the Marck Script era -
// the UI moved to the system font stack 2026-08-06, so no font file is
// required anymore, but a CSS reference to a file the build didn't emit
// would still silently degrade the popup, e.g. the cyrillic-only-font bug of
// 2026-08-02. data:/blob:/#fragment refs are inline and need no file.)
let cssRefs = 0
let cssRefsBad = 0
for (const f of [...walk(DIST)].filter((p) => p.endsWith('.css'))) {
  const rel = f.slice(DIST.length + 1).replaceAll('\\', '/')
  const css = readFileSync(f, 'utf8')
  for (const [, raw] of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]+))\s*\)/g)) {
    const ref = (raw ?? '').trim()
    if (!ref || /^(data:|blob:|#)/.test(ref)) continue
    cssRefs++
    const target = ref.startsWith('/') ? ref.slice(1) : join(dirname(rel), ref)
    const clean = target.split(/[?#]/)[0]
    if (!exists(clean)) {
      bad(`${rel} -> missing asset ${ref}`)
      cssRefsBad++
    }
  }
}
if (cssRefsBad === 0) ok(`all CSS url() references resolve (${cssRefs} file refs checked)`)

// 6. Each HTML entry references at least one script, and every referenced
//    script resolves to a real file. A dangling <script src> means a broken
//    chunk graph that would white-screen the popup on load.
function checkHtmlScripts(htmlRel) {
  if (!htmlRel || !exists(htmlRel)) return
  const html = readFileSync(join(DIST, htmlRel), 'utf8')
  const dir = dirname(htmlRel)
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
  if (srcs.length === 0) {
    bad(`${htmlRel} references no scripts`)
    return
  }
  for (const s of srcs) {
    const rel = s.startsWith('/') ? s.slice(1) : join(dir, s)
    exists(rel) ? ok(`${htmlRel} -> ${s}`) : bad(`${htmlRel} -> missing script ${s} (resolved ${rel})`)
  }
}
checkHtmlScripts(popup)
checkHtmlScripts(offscreen)

// 7. Local embedding model + ONNX WASM runtime are actually bundled - a
// build run without `npm run models:fetch` first (or one where that step
// silently failed) would otherwise pass every check above and still
// white-screen/error at first Check click, since the offscreen document has
// no other source for these files (see SECURITY.md's "Network egress").
const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'
const MODEL_DIR = `models/${MODEL_ID}`
const MIN_ONNX_BYTES = 1_000_000 // real weights are ~34MB; catches a truncated/stub file
for (const rel of [
  `${MODEL_DIR}/config.json`,
  `${MODEL_DIR}/tokenizer.json`,
  `${MODEL_DIR}/tokenizer_config.json`,
]) {
  exists(rel) ? ok(`model file present (${rel})`) : bad(`model file missing: ${rel} (run npm run models:fetch)`)
}
const onnxRel = `${MODEL_DIR}/onnx/model_quantized.onnx`
if (!exists(onnxRel)) {
  bad(`ONNX model missing: ${onnxRel} (run npm run models:fetch)`)
} else if (statSync(join(DIST, onnxRel)).size < MIN_ONNX_BYTES) {
  bad(`ONNX model at ${onnxRel} is suspiciously small (${statSync(join(DIST, onnxRel)).size} bytes) - likely truncated`)
} else {
  ok(`ONNX model present (${onnxRel})`)
}
for (const rel of ['onnx/ort-wasm.wasm', 'onnx/ort-wasm-simd.wasm']) {
  exists(rel) ? ok(`WASM runtime present (${rel})`) : bad(`WASM runtime missing: ${rel} (run npm run models:fetch)`)
}

console.log(failures ? `\nSMOKE FAILED (${failures} issue${failures > 1 ? 's' : ''})` : '\nSMOKE PASSED')
process.exit(failures ? 1 : 0)
