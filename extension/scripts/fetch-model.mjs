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
 */
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const MODEL_ID = 'Xenova/all-MiniLM-L12-v2'
const MODEL_OUT_DIR = resolve(HERE, '..', 'public', 'models', MODEL_ID)
const ONNX_OUT_DIR = resolve(HERE, '..', 'public', 'onnx')
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json']
const ONNX_FILE = 'onnx/model_quantized.onnx'

const ONNX_WASM_FILES = ['ort-wasm.wasm', 'ort-wasm-simd.wasm']

async function fetchFile(url, outPath) {
  process.stdout.write(`- ${outPath.replace(HERE, '.')} ... `)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`FAILED (${res.status})`)
    process.exit(1)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, buf)
  console.log(`ok (${buf.byteLength} bytes)`)
}

await mkdir(MODEL_OUT_DIR, { recursive: true })
await mkdir(resolve(MODEL_OUT_DIR, 'onnx'), { recursive: true })

for (const f of MODEL_FILES) {
  await fetchFile(`${HF_BASE}/${f}`, resolve(MODEL_OUT_DIR, f))
}
await fetchFile(`${HF_BASE}/${ONNX_FILE}`, resolve(MODEL_OUT_DIR, ONNX_FILE))

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
