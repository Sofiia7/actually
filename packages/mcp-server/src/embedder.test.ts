import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('LocalEmbedder laziness', () => {
  // Hermetic per test. The old pattern put doUnmock/resetModules at the END
  // of each test body - cleanup that never runs when an assertion throws, and
  // a fresh registry that the NEXT test silently depends on. Under a full-run
  // worker schedule an un-awaited pipeline import from one test could land in
  // the next test's window and trip its spy (seen 2026-08-18: 1 flaky fail in
  // 3 full runs). Reset BEFORE each test, unmock AFTER - unconditionally.
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.doUnmock('@xenova/transformers')
  })

  it('does not load the pipeline merely by constructing the class', async () => {
    // Asserted against the class's OWN state, not against a module-mock spy.
    //
    // The spy version of this test was flaky twice (2026-08-18, and again in a
    // full `npm test --workspaces` run) because it asserted on a GLOBAL fact -
    // "nothing has imported @xenova/transformers" - which anything else
    // sharing the module registry can falsify. Laziness is not a global fact;
    // it is a property of this object, and `pipelinePromise` staying null is
    // exactly that property. Reading it needs a cast because it is private,
    // which is the honest cost of testing an internal guarantee directly
    // instead of inferring it from a side effect.
    const { LocalEmbedder } = await import('./embedder')
    const embedder = new LocalEmbedder() as unknown as { pipelinePromise: unknown }
    expect(embedder.pipelinePromise).toBeNull()
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
  })
})
