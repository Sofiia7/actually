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

  it('returns the extractor output data and calls it with mean pooling + normalize', async () => {
    const extractorSpy = vi.fn(async () => ({ data: new Float32Array([0.1, 0.2, 0.3]) }))
    vi.doMock('@xenova/transformers', () => ({
      pipeline: vi.fn(async () => extractorSpy),
      env: { allowLocalModels: true },
    }))
    const { LocalEmbedder } = await import('./embedder')
    const embedder = new LocalEmbedder()
    const result = await embedder.embed('some text')
    expect(extractorSpy).toHaveBeenCalledWith('some text', { pooling: 'mean', normalize: true })
    expect(result).toEqual(new Float32Array([0.1, 0.2, 0.3]))
    vi.doUnmock('@xenova/transformers')
    vi.resetModules()
  })

  it('retries the pipeline load on the next call after a failed attempt', async () => {
    const pipelineSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry hiccup'))
      .mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 0, 0]) }))
    vi.doMock('@xenova/transformers', () => ({
      pipeline: pipelineSpy,
      env: { allowLocalModels: true },
    }))
    const { LocalEmbedder } = await import('./embedder')
    const embedder = new LocalEmbedder()
    await expect(embedder.embed('first call')).rejects.toThrow('registry hiccup')
    await expect(embedder.embed('second call')).resolves.toEqual(new Float32Array([1, 0, 0]))
    expect(pipelineSpy).toHaveBeenCalledTimes(2)
    vi.doUnmock('@xenova/transformers')
    vi.resetModules()
  })
})
