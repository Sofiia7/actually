import { beforeEach, describe, expect, it, vi } from 'vitest'

const { disconnectMock, resetSignClientMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(async () => {}),
  resetSignClientMock: vi.fn(),
}))

const { restoreSessionMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn(async () => null as { topic: string; address: string } | null),
}))

vi.mock('./wallet', () => ({
  disconnect: disconnectMock,
  resetSignClient: resetSignClientMock,
  restoreSession: restoreSessionMock,
  startConnect: vi.fn(),
  WCSigner: class {},
}))

import { disconnectWallet, placeOrder, restoreWallet } from './trade'
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

  it('clears storage when restoreSession() finds a DIFFERENT session in place of the stored one (genuine staleness, not a lookup miss)', async () => {
    restoreSessionMock.mockResolvedValue({ topic: 'a-different-topic', address: '0xdef' })
    const result = await restoreWallet()
    expect(result).toBeNull()
    const s = await getSettings()
    expect(s.wcSessionTopic).toBeUndefined()
    expect(s.clobApiKey).toBeUndefined()
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
})
