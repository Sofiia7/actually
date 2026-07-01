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
  const workerUrl = requireEnv('WORKER_URL')
  const workerSecret = requireEnv('WORKER_SHARED_SECRET')
  const writeSecret = DRY_RUN ? undefined : requireEnv('MARKET_CACHE_WRITE_SECRET')

  const fetchTarget = MAX_MARKETS_CACHE + 50
  console.log(`[market-cache-builder] fetching up to ${fetchTarget} markets from ${workerUrl}`)
  const fetchStartedAt = Date.now()
  let markets
  try {
    markets = await fetchActiveMarkets(workerUrl, workerSecret, fetchTarget)
  } catch (err) {
    // fetchActiveMarkets throws a bare `fetch_markets_failed:<status>` with no
    // indication of how long it ran or how close it got to the target before a
    // persistent 5xx gave up retrying. In an unattended cron job this line is
    // often the only diagnostic an operator gets, so make it self-sufficient.
    const elapsedSec = ((Date.now() - fetchStartedAt) / 1000).toFixed(1)
    console.error(
      `[market-cache-builder] fetchActiveMarkets failed after ${elapsedSec}s ` +
        `(requested up to ${fetchTarget} markets from ${workerUrl}/markets): ${(err as Error).message}`,
    )
    throw err
  }
  console.log(`[market-cache-builder] fetched ${markets.length} markets`)

  const { pipeline, env } = await import('@xenova/transformers')
  env.allowLocalModels = false
  const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
  const embed = async (text: string): Promise<Float32Array> => {
    const out = (await extractor(text, { pooling: 'mean', normalize: true })) as { data: Float32Array }
    return out.data
  }

  const toEmbed = markets.slice(0, MAX_MARKETS_CACHE)
  let blob
  try {
    blob = await buildBlob(toEmbed, embed, LOCAL_MODEL_ID, Date.now())
  } catch (err) {
    console.error(
      `[market-cache-builder] buildBlob failed while embedding up to ${toEmbed.length} ` +
        `markets (fetched ${markets.length} total): ${(err as Error).message}`,
    )
    throw err
  }
  console.log(`[market-cache-builder] embedded ${blob.markets.length} markets after noise/binary filtering`)

  if (DRY_RUN) {
    writeFileSync(DRY_RUN_OUTPUT_PATH, JSON.stringify(blob, null, 2))
    console.log(`[market-cache-builder] --dry-run: wrote blob to ${DRY_RUN_OUTPUT_PATH} (not sent to the worker)`)
    return
  }

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
}

main().catch((err) => {
  console.error('[market-cache-builder] failed:', err)
  process.exitCode = 1
})
