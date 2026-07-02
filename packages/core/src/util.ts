export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function floatArrayToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function b64ToFloatArray(b64: string): Float32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let magA = 0
  let magB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Resolve the index of the YES outcome in a PolyMarket's `outcomes` JSON
 * string. Polymarket does not guarantee positional order — for some markets
 * "No" is index 0. Sending a BUY_YES order to clobTokenIds[0] when [0] is
 * actually the NO token would place the trade in the wrong direction
 * (money loss). Always map via the string label.
 *
 * Returns 0 by default if parsing fails or "Yes" not found — the caller
 * should still validate the result.
 */
export function findOutcomeIndex(outcomesJson: string, label: 'Yes' | 'No'): number {
  try {
    const arr = JSON.parse(outcomesJson) as string[]
    const i = arr.findIndex((o) => o?.toLowerCase() === label.toLowerCase())
    return i >= 0 ? i : (label === 'Yes' ? 0 : 1)
  } catch {
    return label === 'Yes' ? 0 : 1
  }
}

/**
 * Read the YES-outcome price from a market's outcomePrices/outcomes JSON
 * strings. Probability is always shown as the YES side; maps by label since
 * some markets list "No" first. Returns 0 on any parse failure — callers
 * that need to distinguish "market has no probability" from "market says 0%"
 * should check for malformed input themselves before calling this.
 */
export function priceFromOutcomes(outcomePrices: string, outcomesJson: string): number {
  const yesIdx = findOutcomeIndex(outcomesJson, 'Yes')
  try {
    const arr = JSON.parse(outcomePrices) as string[]
    return parseFloat(arr[yesIdx] ?? '0')
  } catch {
    return 0
  }
}

/**
 * Parse a JSON-encoded string array (Polymarket Gamma returns `outcomes`
 * and `outcomePrices` as JSON strings, not native arrays). Returns []
 * on any parse failure so callers can default-index without `?.`.
 */
export function safeJsonArray(s: string | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * True only for a binary Yes/No market — exactly two outcomes that are "Yes"
 * and "No" (case-insensitive). The whole UI (YES %, BUY YES / BUY NO, payout
 * math) assumes binary markets; a categorical market like
 * ["Candidate A","Candidate B",...] would otherwise be mislabeled and, worse,
 * a "BUY YES" would route to outcomes[0] (the wrong token). We drop non-binary
 * markets at cache-entry so they never reach discovery or the trade flow.
 *
 * Note: Gamma's /markets endpoint already represents multi-outcome *events* as
 * separate binary sub-markets, so this filters out very few real rows.
 */
export function isBinaryOutcomes(outcomesJson: string): boolean {
  const arr = safeJsonArray(outcomesJson)
  if (arr.length !== 2) return false
  const set = new Set(arr.map((o) => o.trim().toLowerCase()))
  return set.has('yes') && set.has('no')
}

/**
 * Human-friendly relative time. Accepts a Date or a millisecond timestamp.
 * Used in History rows, ResolutionCard, and anywhere we render "X ago".
 */
export function formatRelative(input: Date | number): string {
  const ms = input instanceof Date ? input.getTime() : input
  const diff = ms - Date.now()
  const absMin = Math.round(Math.abs(diff) / 60_000)
  if (absMin < 1) return 'just now'
  // Past
  if (diff < 0) {
    if (absMin < 60) return `${absMin}m ago`
    const h = Math.round(absMin / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.round(h / 24)
    if (d < 7) return `${d}d ago`
    return new Date(ms).toLocaleDateString()
  }
  // Future
  const d = Math.round(diff / 86_400_000)
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  return `in ${d}d`
}

/**
 * Fast non-cryptographic 8-char hash of an arbitrary string. Used as a
 * privacy-safe dimension in telemetry (we count "market X got N matches"
 * without ever sending the raw market id). djb2 in hex, fixed-width.
 */
export function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
