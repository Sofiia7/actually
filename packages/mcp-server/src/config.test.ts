import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('requireWorkerConfig', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('throws when ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET are not set', async () => {
    delete process.env.ACTUALLY_WORKER_URL
    delete process.env.ACTUALLY_WORKER_SECRET

    const { requireWorkerConfig } = await import('./config')

    expect(() => requireWorkerConfig()).toThrow(
      'actually-mcp-server is not configured: set ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET.',
    )
  })

  it('does not throw and returns the values when both are set', async () => {
    process.env.ACTUALLY_WORKER_URL = 'https://worker.example.com'
    process.env.ACTUALLY_WORKER_SECRET = 'test-secret'

    const { requireWorkerConfig } = await import('./config')

    expect(requireWorkerConfig()).toEqual({
      workerUrl: 'https://worker.example.com',
      workerSecret: 'test-secret',
    })
  })
})
