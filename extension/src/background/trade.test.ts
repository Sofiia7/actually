import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { disconnectMock, resetSignClientMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(async () => {}),
  resetSignClientMock: vi.fn(),
}))

const { restoreSessionMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn(async () => null as { topic: string; address: string } | null),
}))

const { pruneOtherSessionsMock, startConnectMock } = vi.hoisted(() => ({
  pruneOtherSessionsMock: vi.fn(async () => 0),
  startConnectMock: vi.fn(async () => ({
    uri: 'wc:test',
    approval: Promise.resolve({ topic: 'topic-new', address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca' }),
  })),
}))

vi.mock('./wallet', () => ({
  disconnect: disconnectMock,
  resetSignClient: resetSignClientMock,
  restoreSession: restoreSessionMock,
  pruneOtherSessions: pruneOtherSessionsMock,
  startConnect: startConnectMock,
  WCSigner: class {},
}))

vi.mock('./geo', () => ({
  getGeoStatus: vi.fn(async () => ({ country: 'RS', blocked: false, unknown: false })),
}))

const { deriveCredentialsMock } = vi.hoisted(() => ({
  deriveCredentialsMock: vi.fn(async () => ({ key: 'k2', secret: 's2', passphrase: 'p2' })),
}))

// Only the two pieces connectWallet needs stubbed — everything else keeps its
// real implementation so the order-path tests below are unaffected.
vi.mock('./clob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./clob')>()),
  makeClient: vi.fn(() => ({}) as never),
  deriveCredentials: deriveCredentialsMock,
}))

import { connectWallet, disconnectWallet, placeOrder, restoreWallet } from './trade'
import { getSettings, saveSettings } from './settings'
import { MAX_ORDER_USD } from '../shared/constants'
import type { WalletState } from './trade'

const fakeState: WalletState = {
  topic: 'topic-1',
  address: '0xabc',
  safeAddress: '0xsafe',
  creds: { key: 'k', secret: 's', passphrase: 'p' },
}

// Minimal fake of the one IDBFactory method wipeWalletConnectStorage() (trade.ts)
// actually calls. The real jsdom/browser IDBOpenDBRequest is event-based
// (onsuccess/onerror/onblocked), so this mirrors that shape rather than
// returning a Promise directly.
function makeFakeIndexedDB(outcome: 'success' | 'error' | 'blocked') {
  const deleteDatabase = vi.fn((_name: string) => {
    const req: { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null } = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
    }
    queueMicrotask(() => {
      if (outcome === 'success') req.onsuccess?.()
      else if (outcome === 'error') req.onerror?.()
      else req.onblocked?.()
    })
    return req
  })
  return { deleteDatabase }
}

describe('disconnectWallet', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await saveSettings({
      wcSessionTopic: 'topic-1',
      walletAddress: '0xabc',
      safeAddress: '0xsafe',
      clobApiKey: 'key',
      clobApiSecret: 'secret',
      clobApiPassphrase: 'pass',
    })
  })

  it('clears all six wallet storage fields on a normal disconnect', async () => {
    await disconnectWallet(fakeState)
    const s = await getSettings()
    expect(s.wcSessionTopic).toBeUndefined()
    expect(s.walletAddress).toBeUndefined()
    expect(s.safeAddress).toBeUndefined()
    expect(s.clobApiKey).toBeUndefined()
    expect(s.clobApiSecret).toBeUndefined()
    expect(s.clobApiPassphrase).toBeUndefined()
  })

  it('still clears storage when the WC-side disconnect rejects (relay unreachable)', async () => {
    disconnectMock.mockRejectedValueOnce(new Error('relay_unreachable'))
    await expect(disconnectWallet(fakeState)).resolves.toBeUndefined()
    const s = await getSettings()
    expect(s.wcSessionTopic).toBeUndefined()
    expect(s.clobApiKey).toBeUndefined()
  })

  it('wipes storage even when state is null (nothing to look up)', async () => {
    await disconnectWallet(null)
    const s = await getSettings()
    expect(s.wcSessionTopic).toBeUndefined()
  })

  it('resets the cached SignClient so a later connect gets a fresh one', async () => {
    await disconnectWallet(fakeState)
    expect(resetSignClientMock).toHaveBeenCalledTimes(1)
  })

  it('resets the cached SignClient even when the WC-side disconnect rejects', async () => {
    disconnectMock.mockRejectedValueOnce(new Error('relay_unreachable'))
    await disconnectWallet(fakeState)
    expect(resetSignClientMock).toHaveBeenCalledTimes(1)
  })

  it('deletes WalletConnect\'s own IndexedDB store by name on disconnect', async () => {
    const fakeIdb = makeFakeIndexedDB('success')
    vi.stubGlobal('indexedDB', fakeIdb)
    try {
      await disconnectWallet(fakeState)
      expect(fakeIdb.deleteDatabase).toHaveBeenCalledTimes(1)
      expect(fakeIdb.deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still resolves and still clears chrome.storage.local when the IndexedDB delete errors', async () => {
    const fakeIdb = makeFakeIndexedDB('error')
    vi.stubGlobal('indexedDB', fakeIdb)
    try {
      await expect(disconnectWallet(fakeState)).resolves.toBeUndefined()
      const s = await getSettings()
      expect(s.clobApiKey).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still resolves when the IndexedDB delete is blocked by another open connection', async () => {
    const fakeIdb = makeFakeIndexedDB('blocked')
    vi.stubGlobal('indexedDB', fakeIdb)
    try {
      await expect(disconnectWallet(fakeState)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not attempt to delete IndexedDB when indexedDB is undefined (this suite\'s default env)', async () => {
    // No vi.stubGlobal here — confirms the guard clause path is itself exercised,
    // not just assumed, and that disconnectWallet still works without it.
    expect(typeof indexedDB).toBe('undefined')
    await expect(disconnectWallet(fakeState)).resolves.toBeUndefined()
  })
})

describe('restoreWallet — session-lookup failures must not destroy stored credentials', () => {
  const storedWalletFields = {
    wcSessionTopic: 'topic-1',
    walletAddress: '0xabc',
    safeAddress: '0xsafe',
    clobApiKey: 'key',
    clobApiSecret: 'secret',
    clobApiPassphrase: 'pass',
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    restoreSessionMock.mockResolvedValue(null)
    await saveSettings(storedWalletFields)
  })

  it('returns null without touching storage when nothing is stored (nothing to restore)', async () => {
    await saveSettings({
      wcSessionTopic: undefined,
      walletAddress: undefined,
      safeAddress: undefined,
      clobApiKey: undefined,
      clobApiSecret: undefined,
      clobApiPassphrase: undefined,
    })
    const result = await restoreWallet()
    expect(result).toBeNull()
    expect(restoreSessionMock).not.toHaveBeenCalled()
  })

  it('regression: restoreSession() finding no session at all does NOT wipe stored credentials — a transient lookup miss (e.g. right after the offscreen document was recreated) must be retryable, not permanently destructive', async () => {
    restoreSessionMock.mockResolvedValue(null)
    const result = await restoreWallet()
    expect(result).toBeNull()
    const s = await getSettings()
    // The whole point of the fix: storage must still hold everything, so
    // the NEXT restoreWallet() call (once the SDK finishes hydrating) can
    // still succeed instead of permanently reporting "disconnected".
    expect(s.wcSessionTopic).toBe('topic-1')
    expect(s.clobApiKey).toBe('key')
    expect(s.clobApiSecret).toBe('secret')
    expect(s.clobApiPassphrase).toBe('pass')
  })

  it('restores the wallet when restoreSession() finds a session matching the stored topic', async () => {
    restoreSessionMock.mockResolvedValue({ topic: 'topic-1', address: '0xabc' })
    const result = await restoreWallet()
    expect(result).toEqual({
      topic: 'topic-1',
      address: '0xabc',
      safeAddress: '0xsafe',
      creds: { key: 'key', secret: 'secret', passphrase: 'pass' },
    })
  })

  it('asks restoreSession() for the stored topic by name instead of letting it pick a session', async () => {
    // The lookup used to take "whichever live session expires last". Nothing
    // prunes WC sessions, so a user who connected more than once has several
    // — and that pick could land on a session that was never ours.
    restoreSessionMock.mockResolvedValue({ topic: 'topic-1', address: '0xabc' })
    await restoreWallet()
    expect(restoreSessionMock).toHaveBeenCalledWith('topic-1')
  })

  it('regression: a DIFFERENT session coming back does NOT wipe stored credentials either', async () => {
    // This is the case that cost a reconnect-with-signature every time it
    // hit. It is not proof of staleness: the store can be mid-hydration, and
    // ours may simply not be visible yet. Report "not right now" and stay
    // recoverable — a real disconnect goes through the Disconnect button,
    // and a real reconnect overwrites these fields anyway.
    restoreSessionMock.mockResolvedValue({ topic: 'a-different-topic', address: '0xdef' })
    const result = await restoreWallet()
    expect(result).toBeNull()
    const s = await getSettings()
    expect(s.wcSessionTopic).toBe('topic-1')
    expect(s.clobApiKey).toBe('key')
    expect(s.clobApiSecret).toBe('secret')
    expect(s.clobApiPassphrase).toBe('pass')
  })

  it('recovers on the very next call after a transient lookup miss, with no reconnect', async () => {
    restoreSessionMock.mockResolvedValueOnce(null)
    expect(await restoreWallet()).toBeNull()
    restoreSessionMock.mockResolvedValueOnce({ topic: 'topic-1', address: '0xabc' })
    expect(await restoreWallet()).toEqual({
      topic: 'topic-1',
      address: '0xabc',
      safeAddress: '0xsafe',
      creds: { key: 'key', secret: 'secret', passphrase: 'pass' },
    })
  })

  it('refuses to pair stored credentials with a different account on the same topic', async () => {
    // Same session, user switched accounts in the wallet. The stored CLOB
    // credentials belong to 0xabc and must not sign for 0xdef — but they are
    // still valid for 0xabc, so they are kept, not destroyed.
    restoreSessionMock.mockResolvedValue({ topic: 'topic-1', address: '0xdef' })
    expect(await restoreWallet()).toBeNull()
    const s = await getSettings()
    expect(s.clobApiKey).toBe('key')
  })
})

describe('connectWallet — housekeeping must never gate the connect', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    startConnectMock.mockResolvedValue({
      uri: 'wc:test',
      approval: Promise.resolve({ topic: 'topic-new', address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca' }),
    })
    deriveCredentialsMock.mockResolvedValue({ key: 'k2', secret: 's2', passphrase: 'p2' })
    pruneOtherSessionsMock.mockResolvedValue(0)
    await saveSettings({
      workerUrl: 'https://w',
      workerSecret: 'sec',
      wcSessionTopic: undefined,
      walletAddress: undefined,
      safeAddress: undefined,
      clobApiKey: undefined,
      clobApiSecret: undefined,
      clobApiPassphrase: undefined,
    })
  })

  // Settings are a single shared store across this file — hand the worker
  // config back the way the later order-path tests expect to find it.
  afterEach(async () => {
    await saveSettings({ workerUrl: undefined, workerSecret: undefined })
  })

  it('regression: a prune that never resolves does not stall the connect or the save', async () => {
    // Tearing down a superseded session is a relay round-trip to a peer that
    // is probably gone. Awaiting it BEFORE persisting put every one of those
    // between the user's signature and a usable wallet: the popup sat on
    // "Connect wallet" forever, and reopening it found nothing stored.
    pruneOtherSessionsMock.mockImplementation(() => new Promise<number>(() => {}))

    const state = await connectWallet({ onUri: () => {} })

    expect(state.topic).toBe('topic-new')
    const s = await getSettings()
    expect(s.wcSessionTopic).toBe('topic-new')
    expect(s.clobApiKey).toBe('k2')
  })

  it('prunes superseded sessions once the new one is safely stored', async () => {
    await connectWallet({ onUri: () => {} })
    expect(pruneOtherSessionsMock).toHaveBeenCalledWith('topic-new')
  })

  it('reuses stored credentials for the same address — a reconnect costs no signature', async () => {
    await saveSettings({
      walletAddress: '0xABCABCABCABCABCABCABCABCABCABCABCABCABCA', // casing must not matter
      clobApiKey: 'k',
      clobApiSecret: 's',
      clobApiPassphrase: 'p',
    })
    const state = await connectWallet({ onUri: () => {} })
    expect(deriveCredentialsMock).not.toHaveBeenCalled()
    expect(state.creds).toEqual({ key: 'k', secret: 's', passphrase: 'p' })
  })

  it('derives fresh credentials when a different address connects', async () => {
    await saveSettings({
      walletAddress: '0xdifferent',
      clobApiKey: 'k',
      clobApiSecret: 's',
      clobApiPassphrase: 'p',
    })
    const state = await connectWallet({ onUri: () => {} })
    expect(deriveCredentialsMock).toHaveBeenCalledTimes(1)
    expect(state.creds).toEqual({ key: 'k2', secret: 's2', passphrase: 'p2' })
  })
})

describe('placeOrder — MAX_ORDER_USD cap', () => {
  // The cap is checked before any settings/geo/wallet work, so these need no
  // extra mocking beyond what's already stubbed above for the module.
  const baseArgs = {
    state: fakeState,
    tokenId: 'tok-1',
    side: 'BUY_YES' as const,
    price: 0.5,
    negRisk: false,
    orderType: 'MARKET' as const,
  }

  it('rejects an order above MAX_ORDER_USD without touching settings/geo/wallet', async () => {
    const result = await placeOrder({ ...baseArgs, sizeUsd: MAX_ORDER_USD + 1 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe(`order_exceeds_max_usd:${MAX_ORDER_USD}`)
  })

  it('does not reject an order exactly at MAX_ORDER_USD on the cap check itself', async () => {
    // Worker isn't configured in this test env, so it still fails — but on
    // worker_not_configured, proving the cap check itself let it through.
    const result = await placeOrder({ ...baseArgs, sizeUsd: MAX_ORDER_USD })
    expect(result.error).not.toContain('order_exceeds_max_usd')
  })

  it("rejects an order under the market's minimum share count, before signing", async () => {
    // $1 at 31¢ buys 3.22 shares — under CLOB's 5-share floor. Previously
    // this reached the CLOB and came back as a bare `clob_rejected`, after
    // the user had already signed it.
    const result = await placeOrder({ ...baseArgs, price: 0.31, sizeUsd: 1 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('order_below_min_size:5')
  })

  it('lets the same amount through where the price clears the floor', async () => {
    const result = await placeOrder({ ...baseArgs, price: 0.15, sizeUsd: 1 })
    expect(result.error).not.toContain('order_below_min_size')
  })

  it("honours a per-market minimum when the market provides one", async () => {
    const result = await placeOrder({ ...baseArgs, price: 0.5, sizeUsd: 5, minOrderSize: 20 })
    expect(result.error).toBe('order_below_min_size:20')
  })
})
