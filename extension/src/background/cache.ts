import type { EmbeddingProvider } from '../shared/types'
import { EMBED_PROGRESS_CHUNK, STORAGE_KEYS } from '../shared/constants'
import { embedBatch } from './embeddings'
import {
  type CachedMarket,
  type MarketCacheBlob,
  type PolyMarket,
  LOCAL_MODEL_ID,
  MAX_MARKETS_CACHE,
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
 * of recomputing embeddings for ~800 markets on-device — on a fresh install
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

/**
 * Fast path: download the Worker's already-embedded market blob instead of
 * computing vectors on-device. The precompute script applies the identical
 * noise/binary filtering (see packages/market-cache-builder/src/buildBlob.ts),
 * so the blob's markets are used as-is, no re-filtering needed. Always fully
 * replaces the stored cache (matching the model, whatever provider produced
 * the previous cache) rather than diffing — there's nothing to reuse from
 * on-device embeddings, and no cross-provider staleness risk since the write
 * is a full overwrite.
 */
async function refreshFromPrecomputedCache(
  workerUrl: string,
  workerSecret: string,
): Promise<{ added: number; reused: number; removed: number }> {
  const res = await fetch(`${workerUrl}/market-cache`, {
    headers: { 'X-Actually-Auth': workerSecret },
  })
  if (!res.ok) {
    throw new Error(`market-cache fetch failed: ${res.status}`)
  }
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
  // comparable across models — wipe and start fresh.
  const stored = await chrome.storage.local.get(STORAGE_KEYS.marketCacheModel)
  const expectedModel = provider === 'local' ? LOCAL_MODEL_ID : 'openai'
  if (stored[STORAGE_KEYS.marketCacheModel] !== expectedModel) {
    await clearMarketCache()
    await chrome.storage.local.set({ [STORAGE_KEYS.marketCacheModel]: expectedModel })
  }

  const rawRemote = await fetchActiveMarkets(
    workerUrl,
    workerSecret,
    MAX_MARKETS_CACHE + 50, // overfetch a bit to compensate for noise/binary filters
  )
  // Drop word-association noise AND non-binary markets — the trade flow assumes
  // a Yes/No pair, so a categorical market must never reach the cache.
  const remote = rawRemote
    .filter((m) => !isNoiseMarket(m.question))
    .filter((m) => isBinaryOutcomes(m.outcomes))
    .slice(0, MAX_MARKETS_CACHE)
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
    const partial = [...reused, ...freshlyEmbedded].slice(0, MAX_MARKETS_CACHE)
    await chrome.storage.local.set({
      [STORAGE_KEYS.marketCache]: partial,
      [STORAGE_KEYS.marketCacheTs]: Date.now(),
    })
  }

  const merged = [...reused, ...freshlyEmbedded].slice(0, MAX_MARKETS_CACHE)
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

/** Wipe cache (e.g., on embedding provider change — dims differ). */
export async function clearMarketCache(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.marketCache, STORAGE_KEYS.marketCacheTs])
}
