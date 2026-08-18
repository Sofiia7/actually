import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))
vi.mock('@polymarket/builder-relayer-client', () => ({
  RelayClient: class {
    execute = executeMock
  },
  RelayerTxType: { SAFE: 'SAFE' },
}))

const KEY = '0x' + '1'.repeat(64)
const TX = { to: '0xcontract', data: '0xdeadbeef', value: '0' }

const ENV_KEYS = [
  'POLYMARKET_BUILDER_API_KEY',
  'POLYMARKET_BUILDER_API_SECRET',
  'POLYMARKET_BUILDER_API_PASSPHRASE',
] as const

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('makeRelayerSubmit — builder credentials gate the whole flow', () => {
  it('refuses BEFORE signing when credentials are missing, and says where to get them', async () => {
    // The SDK signs the Safe transaction before it posts, so without
    // credentials the operator would pay a wallet signature for a request
    // the relayer answers with 401.
    const { makeRelayerSubmit } = await import('./relayerClient')
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/builder_creds_missing/)
    expect(r.error).toMatch(/Settings -> Builders/)
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('submits once credentials are present', async () => {
    process.env.POLYMARKET_BUILDER_API_KEY = 'bk'
    process.env.POLYMARKET_BUILDER_API_SECRET = Buffer.from('s').toString('base64')
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE = 'pp'
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => ({ state: 'STATE_MINED', transactionID: '0xtx' })),
      getTransaction: vi.fn(async () => [{ state: 'STATE_MINED' }]),
    })
    const { makeRelayerSubmit } = await import('./relayerClient')
    expect(await makeRelayerSubmit(KEY)(TX)).toEqual({ success: true, transactionId: '0xtx' })
    expect(executeMock).toHaveBeenCalledOnce()
  })

  it('reports a relayer 401 as an actionable message, not a raw blob', async () => {
    process.env.POLYMARKET_BUILDER_API_KEY = 'bk'
    process.env.POLYMARKET_BUILDER_API_SECRET = Buffer.from('s').toString('base64')
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE = 'pp'
    executeMock.mockRejectedValue(
      new Error('{"error":"request error","status":401,"data":{"error":"invalid authorization"}}'),
    )
    const { makeRelayerSubmit } = await import('./relayerClient')
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/relayer_unauthorized/)
    expect(r.error).toMatch(/Nothing was redeemed/)
  })

  it('never reports an unmined transaction as success', async () => {
    process.env.POLYMARKET_BUILDER_API_KEY = 'bk'
    process.env.POLYMARKET_BUILDER_API_SECRET = Buffer.from('s').toString('base64')
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE = 'pp'
    // wait() resolves undefined for BOTH an on-chain failure and a timeout.
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => undefined),
      getTransaction: vi.fn(async () => [{ state: 'STATE_FAILED' }]),
    })
    const { makeRelayerSubmit } = await import('./relayerClient')
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r).toEqual({ success: false, transactionId: '0xtx', error: 'relayer_state:STATE_FAILED' })
  })
})
