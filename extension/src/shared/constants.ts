import type { Settings } from './types'

// Defaults are provider-aware. Local MiniLM gives lower cosine values for
// semantically-related texts than OpenAI's models, so its thresholds must be
// proportionally lower. These are seed defaults — DEFAULT_SETTINGS chooses
// the right pair for the active provider.
// Empirically calibrated against 300 real markets and a basket of news articles
// (Trump/Iran, Russia/Ukraine, Fed, Bitcoin). MiniLM-L6 cosine scores for the
// best genuinely-related matches land in 0.42–0.56; unrelated matches stay
// below 0.30.
export const CONFIDENCE_THRESHOLD_OPENAI = 0.82
export const LOW_CONFIDENCE_FLOOR_OPENAI = 0.70
export const CONFIDENCE_THRESHOLD_LOCAL = 0.45
export const LOW_CONFIDENCE_FLOOR_LOCAL = 0.30

// Back-compat shims (old name kept for older code paths)
export const CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD_LOCAL
export const LOW_CONFIDENCE_FLOOR = LOW_CONFIDENCE_FLOOR_LOCAL
export const CACHE_TTL_MINUTES = 30
// Markets are cached top-N by volume. At 300, lower-volume but topical markets
// (e.g. Russia/Ukraine ceasefire & territory markets rank ~330-600 by volume)
// fell outside the pool, so a war article could only match the nearest cached
// Russia market (Putin-leadership). 600 pulls those in; first-load embedding on
// the local MiniLM model runs in the offscreen document (no MV3 SW lifetime
// limit) and is diff-cached, so the one-time cost is paid once.
export const MAX_MARKETS_CACHE = 600
export const EMBED_PROGRESS_CHUNK = 25
export const MAX_BODY_TEXT_CHARS = 500
export const HEADLINE_WEIGHT = 2
export const MAX_HISTORY_ITEMS = 10
export const HISTORY_DEDUP_MINUTES = 10
export const TELEMETRY_FLUSH_INTERVAL_MIN = 5

export const COLOR_THRESHOLDS = {
  blue: 0.30,
  yellow: 0.60,
} as const

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

// Bumped when we change the local embedding model — vectors from different
// models are not comparable, so on mismatch the cache is wiped.
export const LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L12-v2'

// Markets matching these patterns are word-association games rather than
// actual outcome predictions. They share so much vocabulary with political
// news that they otherwise dominate matches with no real signal.
export const NOISE_QUESTION_PATTERNS: RegExp[] = [
  /\bwill\b.+\bsay\b\s*["'“]/i,
  /\bwill\b.+\bmention\b/i,
  /\bduring events with\b/i,
  /\bword of the (day|week)\b/i,
]

export const ALARM_NAMES = {
  refreshCache: 'refresh-cache',
  flushTelemetry: 'flush-telemetry',
} as const

export function defaultThresholds(provider: 'local' | 'openai'): {
  confidenceThreshold: number
  lowConfidenceFloor: number
} {
  return provider === 'openai'
    ? { confidenceThreshold: CONFIDENCE_THRESHOLD_OPENAI, lowConfidenceFloor: LOW_CONFIDENCE_FLOOR_OPENAI }
    : { confidenceThreshold: CONFIDENCE_THRESHOLD_LOCAL, lowConfidenceFloor: LOW_CONFIDENCE_FLOOR_LOCAL }
}

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
  // Pre-fill from build-time env so the extension works out-of-the-box on
  // CWS installs. Users who self-host can still override in Settings.
  workerUrl: DEFAULT_WORKER_URL,
  workerSecret: DEFAULT_WORKER_SECRET,
  telemetryEnabled: true,
}

export const POLYMARKET_BASE_URL = 'https://polymarket.com/event'
