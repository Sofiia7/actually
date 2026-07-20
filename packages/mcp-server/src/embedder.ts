import type { Embedder } from '@actually/core'
import { LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from '@actually/core'

type Extractor = (text: string, opts: object) => Promise<{ data: Float32Array }>

/**
 * Embedder backed by the same local MiniLM model the extension uses
 * (LOCAL_MODEL_ID, shared from @actually/core so the precompute script,
 * this server, and the extension can never drift onto different models).
 * The pipeline loads lazily on the first embed() call, not on import or
 * construction — an operator running only place_order/prepare_order never
 * pays the ~33MB model download or ONNX init cost.
 */
export class LocalEmbedder implements Embedder {
  private pipelinePromise: Promise<Extractor> | null = null

  private async getPipeline(): Promise<Extractor> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const { pipeline, env } = await import('@xenova/transformers')
        env.allowLocalModels = false
        // Pinned revision (not 'main', a mutable ref) — see LOCAL_MODEL_REVISION's
        // doc comment in packages/core/src/constants.ts.
        const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID, { revision: LOCAL_MODEL_REVISION })
        return extractor as unknown as Extractor
      })().catch((err) => {
        // Only a FAILED load clears the cache so the next call gets a fresh
        // attempt (network blip, registry hiccup, corrupted cache on a
        // ~33MB first-run download are all plausible). A successful load
        // stays cached forever — the model doesn't change, so there's never
        // a reason to reload it.
        this.pipelinePromise = null
        throw err
      })
    }
    return this.pipelinePromise
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.getPipeline()
    const out = await extractor(text, { pooling: 'mean', normalize: true })
    return out.data
  }
}
