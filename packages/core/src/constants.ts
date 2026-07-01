// Defaults are provider-aware. Local MiniLM gives lower cosine values for
// semantically-related texts than OpenAI's models, so its thresholds must be
// proportionally lower. Empirically calibrated against 300 real markets and a
// basket of news articles (Trump/Iran, Russia/Ukraine, Fed, Bitcoin). MiniLM-L6
// cosine scores for the best genuinely-related matches land in 0.42–0.56;
// unrelated matches stay below 0.30.
export const CONFIDENCE_THRESHOLD_OPENAI = 0.82
export const LOW_CONFIDENCE_FLOOR_OPENAI = 0.70
export const CONFIDENCE_THRESHOLD_LOCAL = 0.45
export const LOW_CONFIDENCE_FLOOR_LOCAL = 0.30

export const COLOR_THRESHOLDS = {
  blue: 0.30,
  yellow: 0.60,
} as const

export const MAX_BODY_TEXT_CHARS = 500
export const HEADLINE_WEIGHT = 2

// Bumped when the local embedding model changes — vectors from different
// models are not comparable, so a mismatch must invalidate any cached vectors.
export const LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L12-v2'

// Markets are cached top-N by volume.
export const MAX_MARKETS_CACHE = 800

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
