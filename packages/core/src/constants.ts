// Defaults are provider-aware. Local MiniLM gives lower cosine values for
// semantically-related texts than OpenAI's models, so its thresholds must be
// proportionally lower. Recalibrated 2026-07-13 against the live 794-market
// cache: genuinely-right matches (Fed/Iran/Ukraine/World Cup) score raw
// 0.53-0.67; topically-adjacent-but-wrong matches (Apple→"xAI best model",
// Taylor Swift→"Rihanna album") land at 0.42-0.49. The old 0.45 threshold let
// that junk band through as CONFIDENT; 0.50 pushes it into the low-confidence
// UI treatment, and floor 0.35 trims the sub-junk tail (nothing legitimate
// was observed below 0.48).
export const CONFIDENCE_THRESHOLD_OPENAI = 0.82
export const LOW_CONFIDENCE_FLOOR_OPENAI = 0.70
export const CONFIDENCE_THRESHOLD_LOCAL = 0.50
export const LOW_CONFIDENCE_FLOOR_LOCAL = 0.35

export const COLOR_THRESHOLDS = {
  blue: 0.30,
  yellow: 0.60,
} as const

export const MAX_BODY_TEXT_CHARS = 500
export const HEADLINE_WEIGHT = 2

// Bumped when the local embedding model changes - vectors from different
// models are not comparable, so a mismatch must invalidate any cached vectors.
export const LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L12-v2'

// Exact HuggingFace commit for LOCAL_MODEL_ID - NOT 'main', a mutable ref.
// The extension bundles the model at build time (see
// extension/scripts/fetch-model.mjs, which also SHA-256-verifies each file
// against this same commit) so its runtime never touches HuggingFace at all.
// mcp-server and market-cache-builder fetch at runtime instead (no bundling
// step), so they pass this as transformers.js's `revision` option to pin
// what they get - without it, a future run could silently fetch different
// bytes than what was reviewed if the upstream repo's `main` ever moves.
export const LOCAL_MODEL_REVISION = 'beeb2e4b69e95f188a15cc2e90d09fd035dac229'

// Markets are cached top-N by volume. At 300, lower-volume but topical markets
// (e.g. Russia/Ukraine ceasefire & territory markets rank ~330-600 by volume)
// fell outside the pool, so a war article could only match the nearest cached
// Russia market (Putin-leadership). 600 pulls those in; first-load embedding on
// the local MiniLM model runs in the offscreen document (no MV3 SW lifetime
// limit) and is diff-cached, so the one-time cost is paid once.
export const MAX_MARKETS_CACHE = 2000

/**
 * Ceiling for the ON-DEVICE fallback, used only when the precomputed blob is
 * unavailable and the extension has to embed markets itself.
 *
 * Deliberately far below MAX_MARKETS_CACHE. The served blob arrives with its
 * embeddings already computed, so its size costs a download; this path costs
 * one MiniLM inference per market in the offscreen document, and 2000 of them
 * on a cold cache is a wait, not a refresh. Coverage on the fallback is worse
 * than the happy path by design - the happy path is what users actually get.
 */
export const MAX_MARKETS_ON_DEVICE = 800

// Markets matching these patterns are word-association games rather than
// actual outcome predictions. They share so much vocabulary with political
// news that they otherwise dominate matches with no real signal.
export const NOISE_QUESTION_PATTERNS: RegExp[] = [
  /\bwill\b.+\bsay\b\s*["'“]/i,
  /\bwill\b.+\bmention\b/i,
  /\bduring events with\b/i,
  /\bword of the (day|week)\b/i,
]

export function defaultThresholds(provider: 'local' | 'openai'): {
  confidenceThreshold: number
  lowConfidenceFloor: number
} {
  return provider === 'openai'
    ? { confidenceThreshold: CONFIDENCE_THRESHOLD_OPENAI, lowConfidenceFloor: LOW_CONFIDENCE_FLOOR_OPENAI }
    : { confidenceThreshold: CONFIDENCE_THRESHOLD_LOCAL, lowConfidenceFloor: LOW_CONFIDENCE_FLOOR_LOCAL }
}
