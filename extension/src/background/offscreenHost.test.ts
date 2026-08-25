import { describe, expect, it, vi, beforeEach } from 'vitest'
import { routeToOffscreen, _resetOffscreenReady } from './offscreen-host'

/**
 * chrome.offscreen.createDocument resolves when the document has been created,
 * not when the script inside it has finished evaluating and registered its
 * message listener. That bundle carries transformers.js and WalletConnect, so
 * the gap is real: the first message after a cold start went out to a document
 * that was not listening yet and came back "Could not establish connection.
 * Receiving end does not exist." - which the popup then reported as a failed
 * connect.
 *
 * OS_PING/OS_PONG existed for this and was never wired to anything.
 */
function installChrome(behaviour: {
  exists?: boolean
  answersFrom?: number // ping attempt (1-based) at which the document starts answering
  dropsAfter?: number // forward attempt at which the document disappears
}) {
  let pings = 0
  let forwards = 0
  const sendMessage = vi.fn(async (msg: { __forward?: boolean; payload?: { type?: string } }) => {
    if (msg.payload?.type === 'OS_PING') {
      pings++
      if (behaviour.answersFrom && pings < behaviour.answersFrom) {
        throw new Error('Could not establish connection. Receiving end does not exist.')
      }
      return { type: 'OS_PONG' }
    }
    forwards++
    if (behaviour.dropsAfter && forwards <= behaviour.dropsAfter) {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    }
    return { type: 'OS_CONNECT_STARTED', sessionId: 'cs_1' }
  })

  const createDocument = vi.fn(async () => {})
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage,
      getContexts: vi.fn(async () => (behaviour.exists === false ? [] : [{}])),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    },
    offscreen: {
      createDocument,
      hasDocument: vi.fn(async () => behaviour.exists !== false),
      Reason: { WORKERS: 'WORKERS' },
    },
  }
  return { sendMessage, createDocument, pings: () => pings, forwards: () => forwards }
}

beforeEach(() => {
  _resetOffscreenReady()
  vi.clearAllMocks()
})

describe('routeToOffscreen', () => {
  it('waits for the document to answer a ping before forwarding', async () => {
    const chromeMock = installChrome({ answersFrom: 3 })
    const res = await routeToOffscreen({ target: 'offscreen', type: 'OS_START_CONNECT' }, { pollMs: 1 })
    expect(res).toEqual({ type: 'OS_CONNECT_STARTED', sessionId: 'cs_1' })
    expect(chromeMock.pings()).toBe(3)
  })

  it('pings once and then stops paying for it on later messages', async () => {
    const chromeMock = installChrome({})
    await routeToOffscreen({ target: 'offscreen', type: 'OS_POLL_CONNECT' }, { pollMs: 1 })
    await routeToOffscreen({ target: 'offscreen', type: 'OS_START_CONNECT' }, { pollMs: 1 })
    expect(chromeMock.pings()).toBe(1)
  })

  it('re-establishes the document when it disappeared mid-session', async () => {
    // Chrome tears an idle offscreen document down on its own; the next
    // message must rebuild it rather than fail the user's click.
    const chromeMock = installChrome({ dropsAfter: 1 })
    const res = await routeToOffscreen({ target: 'offscreen', type: 'OS_START_CONNECT' }, { pollMs: 1 })
    expect(res).toEqual({ type: 'OS_CONNECT_STARTED', sessionId: 'cs_1' })
    expect(chromeMock.forwards()).toBe(2)
  })

  it('says the document never came up rather than passing the raw Chrome error along', async () => {
    installChrome({ answersFrom: Infinity })
    await expect(
      routeToOffscreen({ target: 'offscreen', type: 'OS_START_CONNECT' }, { pollMs: 1, readyTimeoutMs: 5 }),
    ).rejects.toThrow(/offscreen/i)
  })
})
