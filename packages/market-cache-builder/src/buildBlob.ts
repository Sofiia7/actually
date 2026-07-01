import {
  isBinaryOutcomes,
  isNoiseMarket,
  floatArrayToB64,
  sha256,
  type CachedMarket,
  type MarketCacheBlob,
  type PolyMarket,
} from '@actually/core'

/**
 * Pure transform: filter noise/categorical markets, embed each surviving
 * question, and stamp the result into a MarketCacheBlob. `embed` is injected
 * so this is testable without a network call or loading a real model.
 */
export async function buildBlob(
  markets: PolyMarket[],
  embed: (text: string) => Promise<Float32Array>,
  model: string,
  builtAt: number,
): Promise<MarketCacheBlob> {
  const filtered = markets
    .filter((m) => !isNoiseMarket(m.question))
    .filter((m) => isBinaryOutcomes(m.outcomes))

  const out: CachedMarket[] = []
  for (const m of filtered) {
    const vec = await embed(m.question)
    out.push({
      ...m,
      embeddingB64: floatArrayToB64(vec),
      questionHash: await sha256(m.question),
      cachedAt: builtAt,
    })
  }

  return { model, builtAt, markets: out }
}
