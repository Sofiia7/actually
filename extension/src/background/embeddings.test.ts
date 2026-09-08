import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrors packages/mcp-server/src/embedder.test.ts's contract test for the
// exact same failure mode (2026-09-08 audit F21): local-model init is
// lazy and memoized, but a FAILED attempt must not poison every later call
// until the extension restarts.
describe('embedLocal - recovers from a failed pipeline load instead of caching the rejection forever', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.doUnmock('@xenova/transformers')
  })

  it('retries the pipeline load on the next call after a failed attempt (2026-09-08 audit F21)', async () => {
    const pipelineSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry hiccup'))
      .mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 0, 0]) }))
    vi.doMock('@xenova/transformers', () => ({
      pipeline: pipelineSpy,
      env: { allowLocalModels: true, backends: { onnx: { wasm: {} } } },
    }))
    const { embedLocal } = await import('./embeddings')
    await expect(embedLocal('first call')).rejects.toThrow('registry hiccup')
    await expect(embedLocal('second call')).resolves.toEqual(new Float32Array([1, 0, 0]))
    expect(pipelineSpy).toHaveBeenCalledTimes(2)
  })

  it('reuses the loaded pipeline on a second call after a SUCCESSFUL first one (laziness/memoization is not broken by the fix)', async () => {
    const pipelineSpy = vi.fn(async () => async () => ({ data: new Float32Array([1, 0, 0]) }))
    vi.doMock('@xenova/transformers', () => ({
      pipeline: pipelineSpy,
      env: { allowLocalModels: true, backends: { onnx: { wasm: {} } } },
    }))
    const { embedLocal } = await import('./embeddings')
    await embedLocal('first call')
    await embedLocal('second call')
    expect(pipelineSpy).toHaveBeenCalledTimes(1)
  })
})
