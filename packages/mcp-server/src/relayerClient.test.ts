import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, creds } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  // Mutable stand-in for the builder credentials. Deliberately NOT
  // process.env: config.ts reads the environment once at import time, so
  // driving these tests through env means mutating a process-wide global that
  // vitest shares between test files in the same worker — which made this
  // suite pass alone and fail intermittently in a full run.
  creds: {
    key: undefined as string | undefined,
    secret: undefined as string | undefined,
    passphrase: undefined as string | undefined,
    relayerKey: undefined as string | undefined,
    relayerAddress: undefined as string | undefined,
  },
}))

vi.mock('./config', () => {
  const mode = () =>
    creds.key && creds.secret && creds.passphrase
      ? 'builder'
      : creds.relayerKey && creds.relayerAddress
        ? 'relayer'
        : null
  return {
    get BUILDER_API_KEY() {
      return creds.key
    },
    get BUILDER_API_SECRET() {
      return creds.secret
    },
    get BUILDER_API_PASSPHRASE() {
      return creds.passphrase
    },
    get RELAYER_API_KEY() {
      return creds.relayerKey
    },
    get RELAYER_API_KEY_ADDRESS() {
      return creds.relayerAddress
    },
    relayerAuthMode: mode,
    builderCredsConfigured: () => mode() !== null,
  }
})

vi.mock('@polymarket/builder-relayer-client', () => ({
  RelayClient: class {
    execute = executeMock
  },
  RelayerTxType: { SAFE: 'SAFE' },
}))

import { makeRelayerSubmit } from './relayerClient'

const KEY = '0x' + '1'.repeat(64)
const TX = { to: '0xcontract', data: '0xdeadbeef', value: '0' }

function withCreds() {
  creds.key = 'bk'
  creds.secret = Buffer.from('secret-bytes').toString('base64')
  creds.passphrase = 'pp'
}

beforeEach(() => {
  vi.clearAllMocks()
  creds.key = undefined
  creds.secret = undefined
  creds.passphrase = undefined
  creds.relayerKey = undefined
  creds.relayerAddress = undefined
})

describe('makeRelayerSubmit — builder credentials gate the whole flow', () => {
  it('refuses BEFORE signing when credentials are missing, and says where to get them', async () => {
    // The SDK signs the Safe transaction before it posts, so without
    // credentials the operator would pay a wallet signature for a request the
    // relayer answers with 401.
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/builder_creds_missing/)
    expect(r.error).toMatch(/Relayer API Keys/)
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('submits once credentials are present', async () => {
    withCreds()
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => ({ state: 'STATE_MINED', transactionID: '0xtx' })),
      getTransaction: vi.fn(async () => [{ state: 'STATE_MINED' }]),
    })
    expect(await makeRelayerSubmit(KEY)(TX)).toEqual({ success: true, transactionId: '0xtx' })
    expect(executeMock).toHaveBeenCalledOnce()
  })

  it('reports a relayer 401 as an actionable message, not a raw blob', async () => {
    withCreds()
    executeMock.mockRejectedValue(
      new Error('{"error":"request error","status":401,"data":{"error":"invalid authorization"}}'),
    )
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/relayer_unauthorized/)
    expect(r.error).toMatch(/Nothing was redeemed/)
  })

  it('never reports an unmined transaction as success', async () => {
    withCreds()
    // wait() resolves undefined for BOTH an on-chain failure and a timeout.
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => undefined),
      getTransaction: vi.fn(async () => [{ state: 'STATE_FAILED' }]),
    })
    expect(await makeRelayerSubmit(KEY)(TX)).toEqual({
      success: false,
      transactionId: '0xtx',
      error: 'relayer_state:STATE_FAILED',
    })
  })

  it('reports an unconfirmed outcome rather than a failure when polling times out', async () => {
    withCreds()
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => undefined),
      getTransaction: vi.fn(async () => [{ state: 'STATE_EXECUTED' }]),
    })
    const r = await makeRelayerSubmit(KEY)(TX)
    expect(r.error).toBe('redeem_status_unknown:poll_timeout')
    expect(r.transactionId).toBe('0xtx')
  })
})

describe('makeRelayerSubmit — relayer API key mode', () => {
  it('submits with just a relayer key + address (what the settings UI hands out)', async () => {
    creds.relayerKey = 'rk-456'
    creds.relayerAddress = '0xC6B48f603C439B4a6b55462AfCae10594D31242A'
    executeMock.mockResolvedValue({
      state: 'STATE_NEW',
      transactionID: '0xtx',
      wait: vi.fn(async () => ({ state: 'STATE_MINED', transactionID: '0xtx' })),
      getTransaction: vi.fn(async () => [{ state: 'STATE_MINED' }]),
    })
    expect(await makeRelayerSubmit(KEY)(TX)).toEqual({ success: true, transactionId: '0xtx' })
    expect(executeMock).toHaveBeenCalledOnce()
  })
})
