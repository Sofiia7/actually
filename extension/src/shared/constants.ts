import type { Settings } from './types'
import {
  CONFIDENCE_THRESHOLD_LOCAL,
  LOW_CONFIDENCE_FLOOR_LOCAL,
} from '@actually/core'

export {
  COLOR_THRESHOLDS,
  CONFIDENCE_THRESHOLD_LOCAL,
  CONFIDENCE_THRESHOLD_OPENAI,
  LOW_CONFIDENCE_FLOOR_LOCAL,
  LOW_CONFIDENCE_FLOOR_OPENAI,
  LOCAL_MODEL_ID,
  MAX_MARKETS_CACHE,
  NOISE_QUESTION_PATTERNS,
  MAX_BODY_TEXT_CHARS,
  HEADLINE_WEIGHT,
  defaultThresholds,
} from '@actually/core'

// Back-compat shims (old name kept for older code paths)
export const CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD_LOCAL
export const LOW_CONFIDENCE_FLOOR = LOW_CONFIDENCE_FLOOR_LOCAL
export const CACHE_TTL_MINUTES = 30
export const EMBED_PROGRESS_CHUNK = 25
export const MAX_HISTORY_ITEMS = 10
export const HISTORY_DEDUP_MINUTES = 10
export const TELEMETRY_FLUSH_INTERVAL_MIN = 5

export const SMOKE_COLORS = {
  blue: 'rgba(55, 138, 221, 0.65)',
  yellow: 'rgba(186, 117, 23, 0.65)',
  red: 'rgba(162, 45, 45, 0.70)',
} as const

export const DOT_COLORS = {
  blue: '#378ADD',
  yellow: '#EF9F27',
  red: '#E24B4A',
} as const

export const STORAGE_KEYS = {
  settings: 'settings',
  marketCache: 'marketCache',
  marketCacheTs: 'marketCacheTs',
  marketCacheModel: 'marketCacheModel',
  history: 'history',
  tradeLog: 'tradeLog',
  installId: 'installId',
  telemetryQueue: 'telemetryQueue',
} as const

/**
 * How many trades the local activity log keeps. Larger than MAX_HISTORY_ITEMS
 * on purpose: a match you looked at is disposable, a trade you made is the
 * only local record that it ever happened. Positions vanish from Polymarket's
 * API the moment they're sold or redeemed, so without this log a completed
 * sell leaves no trace anywhere in the UI.
 */
export const MAX_TRADE_LOG_ITEMS = 100

/**
 * Whether the extension can redeem a resolved position itself.
 *
 * FALSE today, and deliberately so: Polymarket's relayer requires builder
 * auth headers (POLY_BUILDER_*) on POST /submit, generated from builder API
 * credentials — a different credential from the builder CODE this build
 * bakes in. Verified against the live endpoint 2026-08-17: an
 * unauthenticated submit returns 401 {"error":"invalid authorization"}.
 *
 * That matters for more than the error message. The relayer SDK asks the
 * wallet to SIGN the Safe transaction before it ever posts it, so leaving
 * the in-app button live means every attempt costs the user a wallet
 * prompt and then fails anyway. Until the credentials exist, point at
 * polymarket.com, where the same payout is one click and no signature.
 *
 * Flip to true once the Worker signs builder headers on the extension's
 * behalf (the credential must NOT be baked into the client — it would be
 * public). background/redeem.ts is already written and tested for that day.
 */
export const IN_APP_REDEEM_ENABLED = false

export const ALARM_NAMES = {
  refreshCache: 'refresh-cache',
  flushTelemetry: 'flush-telemetry',
} as const

/**
 * Our app-wide builderCode, baked at build time via Vite. Used by trade.ts
 * when constructing CLOB orders. Read-only for the user — shown for
 * transparency in Settings → About, but not editable.
 *
 * Set BUILDER_CODE in the build env (.env / CI) to your bytes32 from
 * polymarket.com/settings?tab=builder.
 */
export const BUILDER_CODE: string =
  (import.meta.env.VITE_BUILDER_CODE as string | undefined) ?? ''

/**
 * Geo posture for the Trade path. When the `/geo` lookup is `unknown` (Worker
 * misconfig / network / 401 / 503):
 *   - fail-OPEN  → trading proceeds with an inline warning (Polymarket still
 *                  enforces its own block at order time). Convenient for beta.
 *   - fail-CLOSED → wallet connect + order placement are paused until the
 *                  region can be confirmed. The legally-conservative posture.
 *
 * Resolution order:
 *   1. explicit `VITE_GEO_FAIL_OPEN` ('true' | 'false') always wins;
 *   2. otherwise default to OPEN in dev builds and CLOSED in production builds
 *      (so a plain `vite build` ships fail-closed without anyone remembering).
 * Confirmed-restricted countries are ALWAYS hard-blocked regardless of this.
 */
export const GEO_FAIL_OPEN: boolean = (() => {
  const v = import.meta.env.VITE_GEO_FAIL_OPEN as string | undefined
  if (v === 'true') return true
  if (v === 'false') return false
  return Boolean(import.meta.env.DEV)
})()

/**
 * Default Worker URL + secret, baked at build time. Lets the normie flow work
 * with zero setup — users never have to paste anything into Settings. Power
 * users can still override via Settings (kept under "Advanced" toggle).
 *
 * For production CWS builds, set VITE_WORKER_URL and VITE_WORKER_SECRET in
 * .env.local before running `npm run build`.
 */
export const DEFAULT_WORKER_URL: string =
  (import.meta.env.VITE_WORKER_URL as string | undefined) ?? ''
export const DEFAULT_WORKER_SECRET: string =
  (import.meta.env.VITE_WORKER_SECRET as string | undefined) ?? ''

export const DEFAULT_SETTINGS: Settings = {
  confidenceThreshold: CONFIDENCE_THRESHOLD_LOCAL,
  lowConfidenceFloor: LOW_CONFIDENCE_FLOOR_LOCAL,
  embeddingProvider: 'local',
  workerUrl: DEFAULT_WORKER_URL,
  workerSecret: DEFAULT_WORKER_SECRET,
  // Opt-in, not opt-out (changed 2026-07-20). Product works identically
  // either way — nothing here gates on telemetry — and events are tied to a
  // persistent per-install id alongside trading behavior (wallet_connect_*,
  // order_*), which warrants asking first rather than tracking by default
  // and hoping users find Settings → "share anonymous stats" to turn it off.
  telemetryEnabled: false,
  // Off by default, and for a stronger reason than telemetry: the privacy
  // policy promises that on local embeddings (the default) article text never
  // leaves the device, and a search query built from the headline IS article
  // text. Users who want the long tail can trade that away knowingly; nobody
  // gets it traded away for them.
  searchFallbackEnabled: false,
  searchFallbackOfferDismissed: false,
}

export const POLYMARKET_BASE_URL = 'https://polymarket.com/event'

/**
 * Hard backstop on a single order's USD notional, enforced in trade.ts's
 * placeOrder() (not just the UI — a belt-and-suspenders check, same spirit
 * as the mcp-server's own MAX_ORDER_USD). A fat-fingered amount (typing
 * "10000" instead of "100") still has to clear the wallet's own signing
 * confirmation, but that confirmation doesn't reliably surface the USD
 * notional in a way a user would actually notice mid-click. Mirrors the
 * mcp-server's default of $100 for consistency across the product; there is
 * deliberately no in-app toggle to raise it (same reasoning as the
 * server-side control) — an operator who needs a higher ceiling edits this
 * constant and rebuilds.
 */
export const MAX_ORDER_USD = 100
