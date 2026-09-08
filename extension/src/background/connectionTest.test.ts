import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../shared/types'

vi.mock('./settings', () => ({ getSettings: vi.fn() }))

import { getSettings } from './settings'
import { testConnection } from './connectionTest'

const baseSettings: Settings = {
  embeddingProvider: 'local',
  workerUrl: 'https://w.example',
  workerSecret: 'right-secret',
} as Settings

describe('testConnection - auth and cache are checked separately from reachability (2026-09-08 audit F23)', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue(baseSettings)
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    vi.clearAllMocks()
  })

  it('reports auth ok and cache ok when both the secret and the market cache are healthy', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.endsWith('/geo')) return new Response(JSON.stringify({ country: 'US', blocked: false }), { status: 200 })
      if (url.endsWith('/ready')) return new Response(JSON.stringify({ ok: true, problems: [] }), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await testConnection()

    expect(result.worker).toEqual({ ok: true })
    expect(result.auth).toEqual({ ok: true })
    expect(result.cache).toEqual({ ok: true })
  })

  it('reports auth failure on a wrong secret even though /health (unauthenticated) already reported the Worker as reachable', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.endsWith('/geo')) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      if (url.endsWith('/ready')) return new Response(JSON.stringify({ ok: true, problems: [] }), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await testConnection()

    expect(result.worker).toEqual({ ok: true })
    expect(result.auth).toEqual({ ok: false, error: 'http_401' })
  })

  it('reports cache not-ok (without treating it as a transport error) when /ready answers 503 with stale-cache problems', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.endsWith('/geo')) return new Response(JSON.stringify({ country: 'US', blocked: false }), { status: 200 })
      if (url.endsWith('/ready')) {
        return new Response(JSON.stringify({ ok: false, problems: ['market_cache_stale:30h'] }), { status: 503 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await testConnection()

    expect(result.cache).toEqual({ ok: false, error: 'market_cache_stale:30h' })
  })

  it('skips auth and cache checks entirely when the Worker itself is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network error')
    }) as unknown as typeof fetch

    const result = await testConnection()

    expect(result.worker.ok).toBe(false)
    expect(result.auth).toBeUndefined()
    expect(result.cache).toBeUndefined()
  })
})
