// These assertions document CURRENT defects, not the desired contract.
// They use fake credentials, mocked HTTP and isolated scratch files. No trade is sent.
// When fixing an issue, move its case into the owning suite and invert the assertion.
//
// F01, F02, F03, F05, F04, F06, F08, F15, F09, F07 were fixed on 2026-09-08
// (see git log) and their cases moved into the owning suites:
// packages/mcp-server/src/spendGuard.test.ts, tools/placeOrder.test.ts,
// tools/sellOrder.test.ts, clobClient.test.ts, marketStore.test.ts,
// positions.test.ts; extension/src/popup_new/SellTicket.test.tsx,
// TradeTabWired.test.tsx, IntegratedPopup.test.tsx; extension/src/background/
// cache.test.ts, geo.test.ts, telemetry.test.ts; extension/worker/
// worker.test.ts; packages/core/src/matcher.test.ts.
import { afterEach, expect, it, vi } from 'vitest'
import worker from '../../extension/worker/index'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const fakeEnv = {
  WORKER_SHARED_SECRET: 'audit-public-fake', ALLOWED_EXTENSION_ID: 'audit-extension',
  RATE_LIMITER_DO: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
}

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
