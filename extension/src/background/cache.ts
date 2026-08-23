import type { EmbeddingProvider } from '../shared/types'
import { EMBED_PROGRESS_CHUNK, STORAGE_KEYS } from '../shared/constants'
import { embedBatch } from './embeddings'
import {
  type CachedMarket,
  type MarketCacheBlob,
  type PolyMarket,
  LOCAL_MODEL_ID,
  MAX_MARKETS_CACHE,
  MAX_MARKETS_ON_DEVICE,
  fetchActiveMarkets,
  floatArrayToB64,
  isBinaryOutcomes,
  isNoiseMarket,
  sha256,
} from '@actually/core'

export async function getMarketCache(): Promise<CachedMarket[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.marketCache)
  return (data[STORAGE_KEYS.marketCache] as CachedMarket[] | undefined) ?? []
}

export async function getCacheStatus(): Promise<{ count: number; lastUpdated: number }> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.marketCache,
    STORAGE_KEYS.marketCacheTs,
  ])
  const cache = (data[STORAGE_KEYS.marketCache] as CachedMarket[] | undefined) ?? []
  return {
    count: cache.length,
    lastUpdated: (data[STORAGE_KEYS.marketCacheTs] as number | undefined) ?? 0,
  }
}

/**
 * Refreshes the local market cache. The 'local' provider uses the same
 * MiniLM model as the Worker's precomputed `/market-cache` blob (built every
 * 2h by packages/market-cache-builder's cron), so it downloads that instead
 * of recomputing embeddings for ~800 markets on-device - on a fresh install
 * with an empty cache, on-device embedding took 3+ minutes of WASM inference
 * before this existed, every single time, for every new user. Falls back to
 * on-device embedding if the precomputed cache is unreachable/stale/mismatched,
 * and is still used as the primary path for the 'openai' provider (no
 * precomputed OpenAI-embeddings blob exists).
 */
export async function refreshMarketCache(
  provider: EmbeddingProvider,
  workerUrl: string,
  workerSecret: string,
): Promise<{ added: number; reused: number; removed: number }> {
  if (provider === 'local') {
    try {
      return await refreshFromPrecomputedCache(workerUrl, workerSecret)
    } catch (err) {
      console.warn('[cache] precomputed market-cache unavailable, falling back to on-device embedding:', err)
    }
  }
  return refreshByEmbedding(provider, workerUrl, workerSecret)
}

/** Attempts (first try + retries) for the precomputed blob. */
const BLOB_FETCH_ATTEMPTS = 3
const BLOB_RETRY_BASE_MS = 250

/**
 * Fetch the precomputed blob, retrying the failures that a second attempt can
 * actually fix: a dropped connection and the server's own transient codes.
 *
 * Worth the retry because giving up is expensive. The blob is ~7 MB, and the
 * fallback for not having it is embedding hundreds of markets through WASM on
 * the user's device - minutes of work that also needs the same network, so a
 * blip takes out both paths and the user reads "Couldn't load markets:
 * TypeError: Failed to fetch" after a long wait.
 *
 * Deliberately NOT retried: 401/403 (a wrong secret stays wrong) and a model
 * mismatch (the worker will serve the same blob next time). Retrying those
 * only makes the user wait longer for the same answer.
 */
class PermanentFetchFailure extends Error {}

async function fetchBlobWithRetry(workerUrl: string, workerSecret: string): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= BLOB_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${workerUrl}/market-cache`, {
        headers: { 'X-Actually-Auth': workerSecret },
      })
      if (res.ok) return res
      const message = `market-cache fetch failed: ${res.status}`
      if (res.status !== 429 && res.status < 500) throw new PermanentFetchFailure(message)
      lastErr = new Error(message)
    } catch (err) {
      // A permanent failure must escape the retry loop, not feed it.
      if (err instanceof PermanentFetchFailure) throw new Error(err.message)
      lastErr = err
    }
    if (attempt === BLOB_FETCH_ATTEMPTS) break
    await new Promise((resolve) => setTimeout(resolve, BLOB_RETRY_BASE_MS * 2 ** (attempt - 1)))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Fast path: download the Worker's already-embedded market blob instead of
 * computing vectors on-device. The precompute script applies the identical
 * noise/binary filtering (see packages/market-cache-builder/src/buildBlob.ts),
 * so the blob's markets are used as-is, no re-filtering needed. Always fully
 * replaces the stored cache (matching the model, whatever provider produced
 * the previous cache) rather than diffing - there's nothing to reuse from
 * on-device embeddings, and no cross-provider staleness risk since the write
 * is a full overwrite.
 */
async function refreshFromPrecomputedCache(
  workerUrl: string,
  workerSecret: string,
): Promise<{ added: number; reused: number; removed: number }> {
  const res = await fetchBlobWithRetry(workerUrl, workerSecret)
  const blob = (await res.json().catch((err) => {
    throw new Error(`market-cache response was not valid JSON: ${String(err)}`)
  })) as MarketCacheBlob
  if (blob.model !== LOCAL_MODEL_ID) {
    throw new Error(`market-cache model mismatch: worker served "${blob.model}", expected "${LOCAL_MODEL_ID}"`)
  }

  const merged = blob.markets.slice(0, MAX_MARKETS_CACHE)
  const existing = await getMarketCache()
  const existingIds = new Set(existing.map((m) => m.id))
  const newIds = new Set(merged.map((m) => m.id))
  const added = merged.filter((m) => !existingIds.has(m.id)).length
  const removed = existing.filter((m) => !newIds.has(m.id)).length
  const reused = merged.length - added

  await chrome.storage.local.set({
    [STORAGE_KEYS.marketCache]: merged,
    [STORAGE_KEYS.marketCacheTs]: Date.now(),
    [STORAGE_KEYS.marketCacheModel]: LOCAL_MODEL_ID,
  })
  return { added, reused, removed }
}

/**
 * Diff-cache refresh: only embed markets whose id is new or whose question hash
 * changed. Reuses existing embeddings for the rest. Closed/inactive markets are
 * dropped from cache.
 */
async function refreshByEmbedding(
  provider: EmbeddingProvider,
  workerUrl: string,
  workerSecret: string,
): Promise<{ added: number; reused: number; removed: number }> {
  // If the local model id changed since last refresh, vectors are not
  // comparable across models - wipe and start fresh.
  const stored = await chrome.storage.local.get(STORAGE_KEYS.marketCacheModel)
  const expectedModel = provider === 'local' ? LOCAL_MODEL_ID : 'openai'
  if (stored[STORAGE_KEYS.marketCacheModel] !== expectedModel) {
    await clearMarketCache()
    await chrome.storage.local.set({ [STORAGE_KEYS.marketCacheModel]: expectedModel })
  }

  // MAX_MARKETS_ON_DEVICE, not MAX_MARKETS_CACHE: every market this path
  // takes costs a MiniLM inference here rather than arriving pre-embedded in
  // the worker's blob. See the constant's own note.
  const rawRemote = await fetchActiveMarkets(
    workerUrl,
    workerSecret,
    MAX_MARKETS_ON_DEVICE + 50, // overfetch a bit to compensate for noise/binary filters
  )
  // Drop word-association noise AND non-binary markets - the trade flow assumes
  // a Yes/No pair, so a categorical market must never reach the cache.
  const remote = rawRemote
    .filter((m) => !isNoiseMarket(m.question))
    .filter((m) => isBinaryOutcomes(m.outcomes))
    .slice(0, MAX_MARKETS_ON_DEVICE)
  const existing = await getMarketCache()
  const existingById = new Map(existing.map((m) => [m.id, m]))

  const reused: CachedMarket[] = []
  const toEmbed: { market: PolyMarket; hash: string }[] = []

  for (const m of remote) {
    const hash = await sha256(m.question)
    const prev = existingById.get(m.id)
    if (prev && prev.questionHash === hash && prev.embeddingB64) {
      reused.push({ ...m, embeddingB64: prev.embeddingB64, questionHash: hash, cachedAt: prev.cachedAt })
    } else {
      toEmbed.push({ market: m, hash })
    }
  }

  // Embed in chunks so we persist progress between SW restarts. If MV3 kills
  // us mid-refresh, the partial cache is still useful and the next alarm
  // will finish the job (it'll see the saved ones as "reused" via diff-check).
  const freshlyEmbedded: CachedMarket[] = []
  for (let i = 0; i < toEmbed.length; i += EMBED_PROGRESS_CHUNK) {
    const chunk = toEmbed.slice(i, i + EMBED_PROGRESS_CHUNK)
    const vectors = await embedBatch(
      provider,
      chunk.map((t) => t.market.question),
      workerUrl,
      workerSecret,
    )
    for (let j = 0; j < chunk.length; j++) {
      freshlyEmbedded.push({
        ...chunk[j].market,
        embeddingB64: floatArrayToB64(vectors[j] ?? new Float32Array()),
        questionHash: chunk[j].hash,
        cachedAt: Date.now(),
      })
    }
    // Persist partial progress
    const partial = [...reused, ...freshlyEmbedded].slice(0, MAX_MARKETS_ON_DEVICE)
    await chrome.storage.local.set({
      [STORAGE_KEYS.marketCache]: partial,
      [STORAGE_KEYS.marketCacheTs]: Date.now(),
    })
  }

  const merged = [...reused, ...freshlyEmbedded].slice(0, MAX_MARKETS_ON_DEVICE)
  const removed = existing.length - reused.length

  // If nothing needed embedding, still bump the timestamp
  if (toEmbed.length === 0) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.marketCache]: merged,
      [STORAGE_KEYS.marketCacheTs]: Date.now(),
    })
  }

  return { added: freshlyEmbedded.length, reused: reused.length, removed }
}

/** Wipe cache (e.g., on embedding provider change - dims differ). */
export async function clearMarketCache(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.marketCache, STORAGE_KEYS.marketCacheTs])
}
