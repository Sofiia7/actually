/**
 * Fetch the MiniLM-L12-v2 ONNX model files + the onnxruntime-web WASM
 * binaries needed to run the local embedder fully offline, bundled into the
 * .crx instead of fetched at runtime from huggingface.co / cdn.jsdelivr.net.
 *
 *   npm run models:fetch
 *
 * Mirrors fetch-fonts.mjs's pattern (fetch into public/, bundled by Vite's
 * publicDir copy-through) but the output is NOT committed to git — unlike
 * the ~10KB font, this is ~33MB, too large to carry in normal git history.
 * public/models/ and public/onnx/ are gitignored; run this script (or let CI
 * run it, see .github/workflows/ci.yml) before every build.
 *
 * Model files match src/background/embeddings.ts's expectations exactly:
 * transformers.js's default pipeline load path is
 * `{localModelPath}{model_id}/{file}`, with the ONNX weight at
 * `onnx/model_quantized.onnx` (default `quantized: true`).
 *
 * WASM files match onnxruntime-web's single-threaded path (the extension
 * forces `numThreads = 1` — service workers/offscreen docs don't get
 * cross-origin-isolation, so threaded/SIMD-threaded WASM can't be used
 * anyway): only the non-threaded `ort-wasm.wasm` (scalar fallback) and
 * `ort-wasm-simd.wasm` (SIMD, used by default when the browser supports it)
 * are needed.
 *
 * Pinned to an exact commit (not `main`, a mutable ref) with each file's
 * SHA-256 verified after download. `main` silently serving different bytes
 * on a future run — whether from an upstream repo edit or a compromised
 * mirror — would otherwise bake an unverified, unreviewed binary blob (the
 * ONNX model) straight into the shipped extension with no one noticing.
 * Hashes verified against both `main` and this commit at the time they were
 * pinned (2026-07-20). To intentionally update the model: bump
 * MODEL_REVISION to the new commit, delete public/models/, run this script
 * once to see the FAILED hash lines it prints, review the diff is expected,
 * then paste the new hashes into EXPECTED_SHA256 below.
 */
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Read the pinned revision out of @actually/core rather than hardcoding a
// second copy here — this script can't `import` core's TS source directly
// (it's a plain Node script, no TS loader), but a regex read of the one
// line that matters keeps the two values from silently drifting apart the
// way two independent literals eventually do.
const CORE_CONSTANTS_PATH = resolve(HERE, '..', '..', 'packages', 'core', 'src', 'constants.ts')
async function readModelRevision() {
  const src = await readFile(CORE_CONSTANTS_PATH, 'utf8')
  const m = src.match(/LOCAL_MODEL_REVISION\s*=\s*'([0-9a-fA-F]+)'/)
  if (!m) {
    console.error(`Could not find LOCAL_MODEL_REVISION in ${CORE_CONSTANTS_PATH}`)
    process.exit(1)
  }
  return m[1]
}

const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'
const MODEL_REVISION = await readModelRevision()
const MODEL_OUT_DIR = resolve(HERE, '..', 'public', 'models', MODEL_ID)
const ONNX_OUT_DIR = resolve(HERE, '..', 'public', 'onnx')
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json']
const ONNX_FILE = 'onnx/model_quantized.onnx'

const ONNX_WASM_FILES = ['ort-wasm.wasm', 'ort-wasm-simd.wasm']

const EXPECTED_SHA256 = {
  'config.json': '98cfb098e4f623321632b32b3e62d58ea49601e90dd3c13736c42812b4533ab7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'onnx/model_quantized.onnx': 'f51725bc66b2bf5335cacb5c005763b57bcd741172372795819741cd945a9dd9',
}

async function verifyHash(name, buf) {
  const expected = EXPECTED_SHA256[name]
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== expected) {
    console.error(`FAILED hash mismatch for ${name}`)
    console.error(`  expected: ${expected}`)
    console.error(`  actual:   ${actual}`)
    console.error('Either the pinned model revision changed unexpectedly, or EXPECTED_SHA256 is stale — see this file\'s header comment.')
    process.exit(1)
  }
}

async function fetchFile(url, outPath, hashKey) {
  process.stdout.write(`- ${outPath.replace(HERE, '.')} ... `)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`FAILED (${res.status})`)
    process.exit(1)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (hashKey) await verifyHash(hashKey, buf)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, buf)
  console.log(`ok (${buf.byteLength} bytes, sha256 verified)`)
}

await mkdir(MODEL_OUT_DIR, { recursive: true })
await mkdir(resolve(MODEL_OUT_DIR, 'onnx'), { recursive: true })

for (const f of MODEL_FILES) {
  await fetchFile(`${HF_BASE}/${f}`, resolve(MODEL_OUT_DIR, f), f)
}
await fetchFile(`${HF_BASE}/${ONNX_FILE}`, resolve(MODEL_OUT_DIR, ONNX_FILE), ONNX_FILE)

// onnxruntime-web's WASM binaries are copied from the installed npm package
// (pinned by @xenova/transformers' dependency range), not fetched remotely —
// they ship in the package itself, no network round-trip needed or wanted.
const onnxPkgDir = dirname(require.resolve('onnxruntime-web/package.json'))
await mkdir(ONNX_OUT_DIR, { recursive: true })
for (const f of ONNX_WASM_FILES) {
  const src = resolve(onnxPkgDir, 'dist', f)
  const dest = resolve(ONNX_OUT_DIR, f)
  process.stdout.write(`- ${dest.replace(HERE, '.')} (copy from onnxruntime-web) ... `)
  await copyFile(src, dest)
  console.log('ok')
}

console.log(`\nDone. Wrote model files to public/models/${MODEL_ID}/ and WASM to public/onnx/`)
