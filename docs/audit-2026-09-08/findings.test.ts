// These assertions document CURRENT defects, not the desired contract.
// They use fake credentials, mocked HTTP and isolated scratch files. No trade is sent.
// When fixing an issue, move its case into the owning suite and invert the assertion.
//
// F01, F02, F03, F05, F04, F06, F08 were fixed on 2026-09-08 (see git log)
// and their cases moved into the owning suites: packages/mcp-server/src/
// spendGuard.test.ts, tools/placeOrder.test.ts, tools/sellOrder.test.ts,
// clobClient.test.ts, marketStore.test.ts; extension/src/popup_new/
// SellTicket.test.tsx, TradeTabWired.test.tsx; extension/src/background/
// cache.test.ts, geo.test.ts; extension/worker/worker.test.ts;
// packages/core/src/matcher.test.ts.
import { afterEach, expect, it, vi } from 'vitest'
import { fetchPositions } from '../../packages/mcp-server/src/positions'
import { attemptMatch, floatArrayToB64 } from '../../packages/core/src/index'
import { flushTelemetry } from '../../extension/src/background/telemetry'
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../../extension/src/shared/constants'
import worker from '../../extension/worker/index'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function market(id: string, question = 'Will the event happen?', raw = 1) {
  return {
    id, question, slug: id, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
    clobTokenIds: ['yes', 'no'], active: true, closed: false, volume: 0, liquidity: 100,
    embeddingB64: floatArrayToB64(new Float32Array([raw, Math.sqrt(1 - raw * raw)])),
    cachedAt: Date.now(), questionHash: id,
  }
}

const fakeEnv = {
  WORKER_SHARED_SECRET: 'audit-public-fake', ALLOWED_EXTENSION_ID: 'audit-extension',
  RATE_LIMITER_DO: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
}

it('F07: Worker accepts 250 telemetry events but client deletes all 300', async () => {
  const queue = Array.from({ length: 300 }, (_, i) => ({ installId: 'fake', event: 'match_shown', ts: i }))
  await chrome.storage.local.set({ [STORAGE_KEYS.telemetryQueue]: queue })
  let persisted = 0
  vi.stubGlobal('fetch', vi.fn(async (url, init) => worker.fetch(new Request(url, init), {
    ...fakeEnv, TELEMETRY: { writeDataPoint: () => { persisted++ } },
  } as never)))
  await flushTelemetry({ ...DEFAULT_SETTINGS, telemetryEnabled: true, workerUrl: 'https://audit.invalid', workerSecret: fakeEnv.WORKER_SHARED_SECRET })
  expect(persisted).toBe(250)
  expect((await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue))[STORAGE_KEYS.telemetryQueue]).toEqual([])
})

it('F09: missing outcomeIndex in MCP positions silently becomes YES slot 0', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{
    asset: 'no-token', outcome: 'No', negativeRisk: true, size: 5,
    conditionId: `0x${'1'.repeat(64)}`, redeemable: true, curPrice: 1,
  }])))
  expect((await fetchPositions('0x' + '1'.repeat(40)))[0].outcomeIndex).toBe(0)
})

it('F10: /builder-sign parses and accepts an oversized envelope with unused padding', async () => {
  const req = new Request('https://audit.invalid/builder-sign', {
    method: 'POST', headers: { 'X-Actually-Auth': fakeEnv.WORKER_SHARED_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'POST', path: '/submit', body: '{}', padding: 'x'.repeat(300000) }),
  })
  const res = await worker.fetch(req, {
    ...fakeEnv, BUILDER_API_KEY: 'fake', BUILDER_API_PASSPHRASE: 'fake', BUILDER_API_SECRET: btoa('audit-fake'),
  } as never)
  expect(res.status).toBe(200)
})

it('F15: search fallback returns an Over/Under market as a YES/NO match', async () => {
  const candidate = { ...market('non-binary'), outcomes: '["Over","Under"]' }
  const result = await attemptMatch('Will the event happen?', '', {
    store: { getMarkets: async () => [] },
    embedder: { embed: async () => new Float32Array([1, 0]) },
    searchFallback: async () => [candidate],
    thresholds: { lowConfidenceFloor: 0.35, confidenceThreshold: 0.5 },
  })
  expect(result.match?.market.id).toBe('non-binary')
  expect(result.match?.probability).toBe(0.5)
})
