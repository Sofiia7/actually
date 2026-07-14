/**
 * Pluggable embedding provider — local (transformers.js, free) or OpenAI fallback.
 *
 * - `local`:  Xenova/all-MiniLM-L12-v2 — 384 dims, runs in the offscreen document via WASM.
 *             Model weights + the onnxruntime-web WASM runtime are bundled into the .crx
 *             (see scripts/fetch-model.mjs, `npm run models:fetch`) — no huggingface.co or
 *             cdn.jsdelivr.net fetch at runtime, fully offline-installable. First call still
 *             takes longer than subsequent ones (ONNX session init), but there's no network
 *             round-trip.
 * - `openai`: text-embedding-3-small — 1536 dims, ~$0.02 per 1M tokens, via Worker.
 *
 * The matcher only requires that *the same provider* be used for both the article
 * and the market embeddings — dimensions don't have to match across providers,
 * just within a single cache generation.
 */
import type { EmbeddingProvider } from '../shared/types'

// transformers.js v2 was written for window-based contexts and accesses
// several browser globals that don't exist in MV3 service workers
// (`window`, `document`, `navigator.hardwareConcurrency` quirks). Polyfill
// what's needed BEFORE importing the library.
const g = globalThis as unknown as Record<string, unknown>
if (typeof g.window === 'undefined') g.window = globalThis
if (typeof g.document === 'undefined') {
  g.document = {
    createElement: () => ({}),
    documentElement: { style: {} },
    head: { appendChild: () => undefined },
  }
}

let localPipelinePromise: Promise<(t: string, opts: object) => Promise<{ data: Float32Array }>> | null = null

async function getLocalPipeline() {
  if (!localPipelinePromise) {
    localPipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers')
      // Model weights + tokenizer files are bundled into the .crx under
      // public/models/ (see scripts/fetch-model.mjs) instead of fetched from
      // huggingface.co at runtime. allowRemoteModels=false means a missing
      // bundled file fails loudly instead of silently falling back to a
      // network fetch — CSP no longer allows huggingface.co/*.hf.co anyway.
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = chrome.runtime.getURL('models/')
      env.useBrowserCache = false
      // Same for onnxruntime-web's WASM binaries: bundled under public/onnx/
      // instead of the default cdn.jsdelivr.net fetch.
      try {
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('onnx/')
      } catch {
        /* ignore if shape differs */
      }
      // Service workers don't have multi-threading; single-thread WASM only.
      // Also disable proxy mode which uses Web Workers (not allowed in SW).
      try {
        env.backends.onnx.wasm.numThreads = 1
      } catch {
        /* ignore if shape differs */
      }
      // L12-v2: ~33MB, slightly slower than L6 but materially better retrieval
      // quality on news-to-market matching (validated offline on 300 markets).
      const extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L12-v2',
      )
      return extractor as unknown as (t: string, opts: object) => Promise<{ data: Float32Array }>
    })()
  }
  return localPipelinePromise
}

export async function embedLocal(text: string): Promise<Float32Array> {
  const extractor = await getLocalPipeline()
  const out = await extractor(text, { pooling: 'mean', normalize: true })
  return out.data
}

export async function embedLocalBatch(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (const t of texts) out.push(await embedLocal(t))
  return out
}

export async function embedOpenAI(
  texts: string[],
  workerUrl: string,
  workerSecret: string,
): Promise<Float32Array[]> {
  const res = await fetch(`${workerUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Actually-Auth': workerSecret,
    },
    body: JSON.stringify({ texts }),
  })
  if (!res.ok) throw new Error(`embed_openai_failed:${res.status}`)
  const data = (await res.json()) as { embeddings: number[][] }
  return data.embeddings.map((v) => new Float32Array(v))
}

export async function embed(
  provider: EmbeddingProvider,
  text: string,
  workerUrl: string,
  workerSecret: string,
): Promise<Float32Array> {
  if (provider === 'local') return embedLocal(text)
  const [v] = await embedOpenAI([text], workerUrl, workerSecret)
  return v
}

export async function embedBatch(
  provider: EmbeddingProvider,
  texts: string[],
  workerUrl: string,
  workerSecret: string,
): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  if (provider === 'local') return embedLocalBatch(texts)
  return embedOpenAI(texts, workerUrl, workerSecret)
}

export function vectorDimension(provider: EmbeddingProvider): number {
  return provider === 'local' ? 384 : 1536
}
