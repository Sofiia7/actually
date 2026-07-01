/**
 * Precompute the market cache: fetch active Polymarket markets, embed each
 * question with the local MiniLM model, and PUT the result to the worker's
 * /market-cache endpoint. Run on a cron cadence (~30 min, matching the
 * extension's own CACHE_TTL_MINUTES) on infrastructure we control — this
 * does NOT run inside the Cloudflare Worker (Workers can't run ONNX).
 *
 * Required env:
 *   WORKER_URL                 e.g. https://actually-api.example.workers.dev
 *   WORKER_SHARED_SECRET       same public-by-design secret the extension uses
 *   MARKET_CACHE_WRITE_SECRET  private — never baked into any client (not
 *                              required in --dry-run mode, since nothing is PUT)
 *
 * Usage:
 *   npm run build-cache -w @actually/market-cache-builder
 *   npm run build-cache -w @actually/market-cache-builder -- --dry-run
 *     (writes the blob to ./market-cache-blob.json instead of PUTing to the
 *     worker — for inspecting output without touching the live cache)
 */
import { writeFileSync } from 'node:fs'
import { fetchActiveMarkets, LOCAL_MODEL_ID, MAX_MARKETS_CACHE } from '@actually/core'
import { buildBlob } from './buildBlob'

const DRY_RUN = process.argv.includes('--dry-run')
const DRY_RUN_OUTPUT_PATH = 'market-cache-blob.json'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

async function main() {
  // Step tracker — a single catch below logs which stage failed, so an
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
    const markets = await fetchActiveMarkets(workerUrl, workerSecret, fetchTarget)
    console.log(`[market-cache-builder] fetched ${markets.length} markets`)

    step = 'load_model'
    const { pipeline, env } = await import('@xenova/transformers')
    env.allowLocalModels = false
    const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
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
