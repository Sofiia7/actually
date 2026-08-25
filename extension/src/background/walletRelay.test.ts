import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * A WalletConnect request travels over a relay WebSocket. That socket does not
 * survive a long idle - come back to the extension a day later and the session
 * is still stored, still valid, and pointed at a socket that is no longer
 * there. Sending into it produces no error and no answer: the wallet never
 * hears the request, so the user approves nothing and the popup waits on a
 * promise that will not settle. "I signed and nothing happened" is the same
 * report either way, which is why this is worth making explicit.
 */
const { relayer, requestMock } = vi.hoisted(() => ({
  relayer: { connected: true, transportOpen: vi.fn(async () => {}) },
  requestMock: vi.fn(async () => '0xsignature'),
}))

vi.mock('@walletconnect/sign-client', () => ({
  SignClient: {
    init: vi.fn(async () => ({
      core: { relayer },
      connect: vi.fn(),
      session: { getAll: () => [] },
      disconnect: vi.fn(async () => {}),
      request: requestMock,
    })),
  },
}))

import { _resetSignClient, signTypedData } from './wallet'

beforeEach(() => {
  vi.clearAllMocks()
  _resetSignClient()
  relayer.connected = true
  relayer.transportOpen.mockImplementation(async () => {})
  requestMock.mockImplementation(async () => '0xsignature')
})

describe('signing over a session that has been idle', () => {
  it('does not touch a relay that is already up', async () => {
    await signTypedData('topic-1', '0xabc', { hello: 'world' })
    expect(relayer.transportOpen).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalled()
  })

  it('reopens a dropped relay before sending the signature request', async () => {
    relayer.connected = false
    const order: string[] = []
    relayer.transportOpen.mockImplementation(async () => {
      order.push('transportOpen')
    })
    requestMock.mockImplementation(async () => {
      order.push('request')
      return '0xsignature'
    })

    const sig = await signTypedData('topic-1', '0xabc', { hello: 'world' })

    expect(order).toEqual(['transportOpen', 'request'])
    expect(sig).toBe('0xsignature')
  })

  it('says the relay is unreachable instead of sending into a dead socket', async () => {
    relayer.connected = false
    relayer.transportOpen.mockImplementation(async () => {
      throw new Error('socket refused')
    })

    await expect(signTypedData('topic-1', '0xabc', {})).rejects.toThrow(/relay/i)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('gives up on a reopen that never finishes, rather than hanging forever', async () => {
    relayer.connected = false
    relayer.transportOpen.mockImplementation(() => new Promise<never>(() => {}))

    await expect(signTypedData('topic-1', '0xabc', {}, { relayTimeoutMs: 5 })).rejects.toThrow(/relay/i)
    expect(requestMock).not.toHaveBeenCalled()
  })
})
