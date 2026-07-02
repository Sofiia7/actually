import { describe, expect, it, vi } from 'vitest'

describe('LocalEmbedder laziness', () => {
  it('does not import @xenova/transformers merely by constructing the class', async () => {
    const importSpy = vi.fn()
    vi.doMock('@xenova/transformers', () => {
      importSpy()
      return {
        pipeline: vi.fn(async () => async () => ({ data: new Float32Array([1, 0, 0]) })),
        env: { allowLocalModels: true },
      }
    })
    const { LocalEmbedder } = await import('./embedder')
    new LocalEmbedder()
    // Module construction alone must not have loaded the pipeline.
    expect(importSpy).not.toHaveBeenCalled()
    vi.doUnmock('@xenova/transformers')
    vi.resetModules()
  })

  it('loads the pipeline on the first embed() call and reuses it on the second', async () => {
    const pipelineSpy = vi.fn(async () => async () => ({ data: new Float32Array([1, 0, 0]) }))
    vi.doMock('@xenova/transformers', () => ({
      pipeline: pipelineSpy,
      env: { allowLocalModels: true },
    }))
    const { LocalEmbedder } = await import('./embedder')
    const embedder = new LocalEmbedder()
    await embedder.embed('first call')
    await embedder.embed('second call')
    expect(pipelineSpy).toHaveBeenCalledTimes(1)
    vi.doUnmock('@xenova/transformers')
    vi.resetModules()
  })
})
