import type { Embedder } from '@actually/core'
import { LOCAL_MODEL_ID } from '@actually/core'

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
        const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID)
        return extractor as unknown as Extractor
      })()
    }
    return this.pipelinePromise
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.getPipeline()
    const out = await extractor(text, { pooling: 'mean', normalize: true })
    return out.data
  }
}
