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

describe('spend limit env vars', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults MAX_ORDER_USD/DAILY_LIMIT_USD when unset', async () => {
    delete process.env.ACTUALLY_MAX_ORDER_USD
    delete process.env.ACTUALLY_DAILY_LIMIT_USD
    const { MAX_ORDER_USD, DAILY_LIMIT_USD } = await import('./config')
    expect(MAX_ORDER_USD).toBe(100)
    expect(DAILY_LIMIT_USD).toBe(500)
  })

  it('reads a valid operator-configured value', async () => {
    process.env.ACTUALLY_MAX_ORDER_USD = '25'
    process.env.ACTUALLY_DAILY_LIMIT_USD = '1000'
    const { MAX_ORDER_USD, DAILY_LIMIT_USD } = await import('./config')
    expect(MAX_ORDER_USD).toBe(25)
    expect(DAILY_LIMIT_USD).toBe(1000)
  })

  it('falls back to the default on a non-numeric or non-positive value', async () => {
    process.env.ACTUALLY_MAX_ORDER_USD = 'not-a-number'
    process.env.ACTUALLY_DAILY_LIMIT_USD = '-5'
    const { MAX_ORDER_USD, DAILY_LIMIT_USD } = await import('./config')
    expect(MAX_ORDER_USD).toBe(100)
    expect(DAILY_LIMIT_USD).toBe(500)
  })
})
