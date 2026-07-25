import { beforeEach, describe, expect, it, vi } from 'vitest'

const { disconnectMock, resetSignClientMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(async () => {}),
  resetSignClientMock: vi.fn(),
}))

vi.mock('./wallet', () => ({
  disconnect: disconnectMock,
  resetSignClient: resetSignClientMock,
  restoreSession: vi.fn(async () => null),
  startConnect: vi.fn(),
  WCSigner: class {},
}))

import { disconnectWallet } from './trade'
import { getSettings, saveSettings } from './settings'
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
