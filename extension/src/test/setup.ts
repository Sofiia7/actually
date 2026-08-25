import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Minimal chrome.* mock so popup components/modules that touch the extension
// APIs render under jsdom. Backed by an in-memory store. Tests that need
// specific RPC behavior mock the relevant module (e.g. popup_new/ops) directly.
const store: Record<string, unknown> = {}

const chromeMock = {
  runtime: {
    getManifest: () => ({ version: '1.0.0-test' }),
    getURL: (path = '') => `chrome-extension://test-extension-id/${path}`,
    sendMessage: vi.fn(async () => ({})),
    getContexts: vi.fn(async () => []),
    onMessage: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[]) => {
        if (typeof keys === 'string') return { [keys]: store[keys] }
        if (Array.isArray(keys)) {
          const o: Record<string, unknown> = {}
          for (const k of keys) o[k] = store[k]
          return o
        }
        return { ...store }
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(store, obj)
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
      }),
    },
  },
  tabs: { query: vi.fn(async () => [{ id: 1 }]) },
  scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
  offscreen: {},
}

;(globalThis as unknown as { chrome: unknown }).chrome = chromeMock
