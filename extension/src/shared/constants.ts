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
  installId: 'installId',
  telemetryQueue: 'telemetryQueue',
} as const

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
  telemetryEnabled: true,
}

export const POLYMARKET_BASE_URL = 'https://polymarket.com/event'
