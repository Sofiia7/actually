import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('requireWorkerConfig', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  // In the published package, __DEFAULT_WORKER_URL__/__DEFAULT_WORKER_SECRET__
  // are baked in by tsup (see tsup.config.ts) so this only throws in an
  // unbuilt/test context where those defines don't exist — the typeof guard
  // in config.ts falls back to '', reproducing the pre-bake behavior here.
  it('throws when no env vars are set and no default was baked in', async () => {
    delete process.env.ACTUALLY_WORKER_URL
    delete process.env.ACTUALLY_WORKER_SECRET

    const { requireWorkerConfig } = await import('./config')

    expect(() => requireWorkerConfig()).toThrow(
      'actually-mcp-server is not configured: set ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET.',
    )
  })

  it('env vars override the baked-in default when both are set', async () => {
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

describe('SPEND_GUARD_STATE_PATH', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults to spend-guard.json under a per-user actually-mcp-server directory', async () => {
    delete process.env.ACTUALLY_SPEND_STATE_PATH
    const { SPEND_GUARD_STATE_PATH } = await import('./config')
    expect(SPEND_GUARD_STATE_PATH).toContain('actually-mcp-server')
    expect(SPEND_GUARD_STATE_PATH.endsWith('spend-guard.json')).toBe(true)
  })

  it('honors an operator-configured override path', async () => {
    process.env.ACTUALLY_SPEND_STATE_PATH = '/custom/path/state.json'
    const { SPEND_GUARD_STATE_PATH } = await import('./config')
    expect(SPEND_GUARD_STATE_PATH).toBe('/custom/path/state.json')
  })
})

describe('REDEEM_ENABLED', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('defaults to false — redeem_position needs an explicit second opt-in beyond PRIVATE_KEY', async () => {
    delete process.env.ACTUALLY_ENABLE_REDEEM
    const { REDEEM_ENABLED } = await import('./config')
    expect(REDEEM_ENABLED).toBe(false)
  })

  it('is true only for the exact string "true"', async () => {
    process.env.ACTUALLY_ENABLE_REDEEM = 'true'
    expect((await import('./config')).REDEEM_ENABLED).toBe(true)

    vi.resetModules()
    process.env.ACTUALLY_ENABLE_REDEEM = '1'
    expect((await import('./config')).REDEEM_ENABLED).toBe(false)

    vi.resetModules()
    process.env.ACTUALLY_ENABLE_REDEEM = 'yes'
    expect((await import('./config')).REDEEM_ENABLED).toBe(false)
  })
})
