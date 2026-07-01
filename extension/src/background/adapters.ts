/**
 * Adapters that satisfy @actually/core's MarketStore / Embedder interfaces
 * using the extension's actual runtime: chrome.storage for the market cache,
 * the pluggable local/OpenAI embedding provider for text embedding.
 */
import type { Embedder, MarketStore } from '@actually/core'
import type { Settings } from '../shared/types'
import { getMarketCache } from './cache'
import { embed } from './embeddings'

export function makeChromeMarketStore(): MarketStore {
  return {
    getMarkets: () => getMarketCache(),
  }
}

export function makeSettingsEmbedder(settings: Settings): Embedder {
  return {
    embed: (text: string) => embed(settings.embeddingProvider, text, settings.workerUrl, settings.workerSecret),
  }
}
