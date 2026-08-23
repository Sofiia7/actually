import { describe, expect, it, vi, beforeEach } from 'vitest'

// SignClient is the only thing wallet.ts pulls in; stub it so startConnect can
// be driven with the exact session shapes wallets really return.
const { connectMock, sessionGetAll } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  sessionGetAll: vi.fn(() => [] as unknown[]),
}))

vi.mock('@walletconnect/sign-client', () => ({
  SignClient: {
    init: vi.fn(async () => ({
      connect: connectMock,
      session: { getAll: sessionGetAll },
      disconnect: vi.fn(async () => {}),
      request: vi.fn(),
    })),
  },
}))

import { startConnect } from './wallet'

const POLY = 'eip155:137'

function approvedWith(namespaces: Record<string, unknown>) {
  connectMock.mockResolvedValue({
    uri: 'wc:test',
    approval: async () => ({ topic: 'topic-1', namespaces }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startConnect - the approved session must actually grant what signing needs', () => {
  it('sends BOTH namespace fields - wallets that render from requiredNamespaces must not be starved', async () => {
    // Sending only optionalNamespaces (to silence the SDK's deprecation
    // warning) left such wallets with nothing to build an approval screen
    // from: they spin forever and never prompt. The warning is noise;
    // interop is not.
    approvedWith({
      eip155: { accounts: [`${POLY}:0xABC`], methods: ['eth_signTypedData_v4'], events: [] },
    })
    await startConnect()
    const arg = connectMock.mock.calls[0][0]
    for (const field of ['requiredNamespaces', 'optionalNamespaces'] as const) {
      expect(arg[field].eip155.chains).toContain(POLY)
      expect(arg[field].eip155.methods).toContain('eth_signTypedData_v4')
    }
  })

  it('accepts a session granting Polygon and the signing method', async () => {
    approvedWith({
      eip155: { accounts: [`${POLY}:0xAbCdEf`], methods: ['eth_signTypedData_v4'], events: [] },
    })
    const { approval } = await startConnect()
    await expect(approval).resolves.toEqual({ topic: 'topic-1', address: '0xabcdef' })
  })

  it('rejects a session approved on the wrong chain, naming what was granted', async () => {
    // This is the failure that used to be invisible: approval succeeds, and
    // only the later signature request fails - long after the user has been
    // told the wallet is connected.
    approvedWith({
      eip155: { accounts: ['eip155:1:0xABC'], methods: ['eth_signTypedData_v4'], events: [] },
    })
    const { approval } = await startConnect()
    await expect(approval).rejects.toThrow('wc_no_polygon_account:eip155:1')
  })

  it('rejects a session that never granted the signing method', async () => {
    approvedWith({
      eip155: { accounts: [`${POLY}:0xABC`], methods: ['personal_sign'], events: [] },
    })
    const { approval } = await startConnect()
    await expect(approval).rejects.toThrow('wc_method_not_granted:eth_signTypedData_v4')
  })

  it('picks the Polygon account even when the wallet lists other chains first', async () => {
    approvedWith({
      eip155: {
        accounts: ['eip155:1:0xETH', `${POLY}:0xPOLY`],
        methods: ['eth_signTypedData_v4'],
        events: [],
      },
    })
    const { approval } = await startConnect()
    await expect(approval).resolves.toMatchObject({ address: '0xpoly' })
  })

  it('fails clearly when the wallet approves with no eip155 namespace at all', async () => {
    approvedWith({ solana: { accounts: [], methods: [], events: [] } })
    const { approval } = await startConnect()
    await expect(approval).rejects.toThrow('wc_no_polygon_account:none')
  })
})
