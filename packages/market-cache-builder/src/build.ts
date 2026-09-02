/**
 * Precompute the market cache: fetch active Polymarket markets, embed each
 * question with the local MiniLM model, and PUT the result to the worker's
 * /market-cache endpoint. Run on a cron cadence (~30 min, matching the
 * extension's own CACHE_TTL_MINUTES) on infrastructure we control - this
 * does NOT run inside the Cloudflare Worker (Workers can't run ONNX).
 *
 * Required env:
 *   WORKER_URL                 e.g. https://actually-api.example.workers.dev
 *   WORKER_SHARED_SECRET       same public-by-design secret the extension uses
 *   MARKET_CACHE_WRITE_SECRET  private - never baked into any client (not
 *                              required in --dry-run mode, since nothing is PUT)
 *
 * Usage:
 *   npm run build-cache -w @actually/market-cache-builder
 *   npm run build-cache -w @actually/market-cache-builder -- --dry-run
 *     (writes the blob to ./market-cache-blob.json instead of PUTing to the
 *     worker - for inspecting output without touching the live cache)
 */
import { writeFileSync } from 'node:fs'
import { fetchActiveMarkets, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION, MAX_MARKETS_CACHE } from '@actually/core'
import { buildBlob } from './buildBlob'

const DRY_RUN = process.argv.includes('--dry-run')
const DRY_RUN_OUTPUT_PATH = 'market-cache-blob.json'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

/**
 * Wait between rate-limited attempts, both inside a page and between whole
 * passes. A 429 means a per-minute quota is spent, so any wait shorter than
 * the window retries into the same wall - the 2026-09-02 run failed after
 * three attempts inside 37 seconds on the old 2s/4s backoff. Worst case now
 * is roughly ten minutes before the run gives up, which a two-hourly cron on
 * unmetered public-repo runners can afford.
 */
const RATE_LIMIT_WAIT_MS = 60_000

/**
 * Retries a transient failure (HuggingFace 429s under cron-job load being the
 * one actually observed in prod) with a short backoff. Model loading is a
 * one-shot network fetch with no retry of its own in transformers.js - a
 * single rate-limit response otherwise fails the entire cron run.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 2000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i
        console.warn(`[market-cache-builder] attempt ${i + 1}/${attempts} failed, retrying in ${delay}ms:`, err)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastErr
}

async function main() {
  // Step tracker - a single catch below logs which stage failed, so an
  // unattended cron job's log has one self-sufficient diagnostic line
  // instead of a bare, context-free stack trace.
  let step = 'init'
  try {
    step = 'read_env'
    const workerUrl = requireEnv('WORKER_URL')
    const workerSecret = requireEnv('WORKER_SHARED_SECRET')
    const writeSecret = DRY_RUN ? undefined : requireEnv('MARKET_CACHE_WRITE_SECRET')

    step = 'fetch_markets'
    const fetchTarget = MAX_MARKETS_CACHE + 50
    console.log(`[market-cache-builder] fetching up to ${fetchTarget} markets from ${workerUrl}`)
    // Retried for the same reason the model load is: Gamma answers a cron that
    // pages through ~2000 markets with a 429 often enough to matter, and an
    // unretried one fails the whole run (observed 2026-08-25, between two runs
    // that succeeded either side of it). A failed run is not harmless - it
    // leaves the served cache to go stale until the next one lands.
    //
    // Both waits are a minute rather than seconds: 2026-09-02 proved the old
    // backoff retried inside the very window it was waiting out. The inner one
    // retries just the rate-limited page, which is far cheaper than restarting
    // a ~35s paging pass, so the outer retry is only the net under it.
    const markets = await withRetry(
      () => fetchActiveMarkets(workerUrl, workerSecret, fetchTarget, { rateLimitRetryMs: RATE_LIMIT_WAIT_MS }),
      3,
      RATE_LIMIT_WAIT_MS,
    )
    console.log(`[market-cache-builder] fetched ${markets.length} markets`)

    step = 'load_model'
    const { pipeline, env } = await import('@xenova/transformers')
    env.allowLocalModels = false
    // transformers.js's own default cacheDir is NOT cwd-relative - env.js
    // derives it from `import.meta.url` of the library's OWN module file, so
    // it resolves to node_modules/@xenova/transformers/.cache/ regardless of
    // where this script runs from. The CI workflow's `actions/cache@v4` step
    // caches `packages/market-cache-builder/.cache` (a path nothing ever
    // wrote to) while `npm ci` reinstalls fresh node_modules every run - so
    // the model was silently being re-downloaded from HuggingFace on every
    // single cron execution, not just on a cache-key change. Setting this
    // explicitly makes the actual cache location match what CI persists.
    env.cacheDir = './.cache'
    // Pinned revision (not 'main', a mutable ref) - see LOCAL_MODEL_REVISION's
    // doc comment in packages/core/src/constants.ts.
    const extractor = await withRetry(() =>
      pipeline('feature-extraction', LOCAL_MODEL_ID, { revision: LOCAL_MODEL_REVISION }),
    )
    const embed = async (text: string): Promise<Float32Array> => {
      const out = (await extractor(text, { pooling: 'mean', normalize: true })) as { data: Float32Array }
      return out.data
    }

    step = 'build_blob'
    const toEmbed = markets.slice(0, MAX_MARKETS_CACHE)
    const blob = await buildBlob(toEmbed, embed, LOCAL_MODEL_ID, Date.now())
    console.log(`[market-cache-builder] embedded ${blob.markets.length} markets after noise/binary filtering`)

    if (DRY_RUN) {
      step = 'write_dry_run_file'
      writeFileSync(DRY_RUN_OUTPUT_PATH, JSON.stringify(blob, null, 2))
      console.log(`[market-cache-builder] --dry-run: wrote blob to ${DRY_RUN_OUTPUT_PATH} (not sent to the worker)`)
      return
    }

    step = 'put_worker'
    const res = await fetch(`${workerUrl}/market-cache`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Actually-Auth': workerSecret,
        'X-Actually-Cache-Write': writeSecret!,
      },
      body: JSON.stringify(blob),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`market-cache PUT failed: ${res.status} ${text}`)
    }
    const result = (await res.json()) as { ok: boolean; count: number }
    console.log(`[market-cache-builder] wrote ${result.count} markets to the worker cache`)
  } catch (err) {
    console.error(`[market-cache-builder] failed at step "${step}":`, err)
    process.exitCode = 1
  }
}

main()
