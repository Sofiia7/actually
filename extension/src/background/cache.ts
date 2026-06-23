import type { CachedMarket, EmbeddingProvider, PolyMarket } from '../shared/types'
import {
  EMBED_PROGRESS_CHUNK,
  LOCAL_MODEL_ID,
  MAX_MARKETS_CACHE,
  NOISE_QUESTION_PATTERNS,
  STORAGE_KEYS,
} from '../shared/constants'
import { fetchActiveMarkets } from './polymarket'
import { embedBatch } from './embeddings'
import { floatArrayToB64, isBinaryOutcomes, sha256 } from './util'

function isNoiseMarket(question: string): boolean {
  return NOISE_QUESTION_PATTERNS.some((re) => re.test(question))
}

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
 * Diff-cache refresh: only embed markets whose id is new or whose question hash
 * changed. Reuses existing embeddings for the rest. Closed/inactive markets are
 * dropped from cache.
 */
export async function refreshMarketCache(
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
