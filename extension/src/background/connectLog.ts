/**
 * A durable, user-readable trace of the wallet connect flow.
 *
 * Why this exists: every failure in this flow so far has been invisible. The
 * popup closes on focus loss (taking its console with it), the offscreen
 * document's console needs chrome://extensions → Inspect views to reach, and
 * Chrome forbids any external tool from attaching to another extension's
 * pages. So the only way anyone - user or maintainer - has been able to
 * describe a failure is by its symptom, which is how the same bug got "fixed"
 * repeatedly without being found.
 *
 * Entries go to chrome.storage.local so they survive the popup closing, the
 * offscreen document being evicted, and the browser restarting. Settings shows
 * them with a copy button.
 *
 * Nothing secret is recorded: no API key, secret, passphrase, or signature.
 * Addresses are truncated. The WC pairing URI is never stored - it is a
 * live connection credential.
 */
const KEY = 'connectLog'
const MAX_ENTRIES = 60

export interface ConnectLogEntry {
  /** ms since epoch */
  t: number
  step: string
  detail?: string
}

/** Redact anything that could be a secret or a full address. */
export function redact(value: unknown): string {
  let s = typeof value === 'string' ? value : String(value)
  // Pairing URIs carry the symmetric key - never record one.
  s = s.replace(/wc:[^\s"']+/gi, 'wc:<uri redacted>')
  // 0x-addresses / hashes → first 6 + last 4.
  s = s.replace(/0x[a-fA-F0-9]{8,}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

export async function logConnect(step: string, detail?: unknown): Promise<void> {
  try {
    const entry: ConnectLogEntry = {
      t: Date.now(),
      step,
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    }
    const data = await chrome.storage.local.get(KEY)
    const prev = (data[KEY] as ConnectLogEntry[] | undefined) ?? []
    // Keep the most recent MAX_ENTRIES; this is a diagnostic buffer, not a
    // permanent record, and it must never grow without bound.
    const next = [...prev, entry].slice(-MAX_ENTRIES)
    await chrome.storage.local.set({ [KEY]: next })
  } catch {
    // Diagnostics must never break the thing they are diagnosing.
  }
}

export async function getConnectLog(): Promise<ConnectLogEntry[]> {
  try {
    const data = await chrome.storage.local.get(KEY)
    return (data[KEY] as ConnectLogEntry[] | undefined) ?? []
  } catch {
    return []
  }
}

export async function clearConnectLog(): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: [] })
  } catch {
    // ignore
  }
}

/** Render the log as plain text for the Settings copy button. */
export function formatConnectLog(entries: ConnectLogEntry[]): string {
  if (entries.length === 0) return 'No connect attempts recorded yet.'
  const t0 = entries[0].t
  return entries
    .map((e) => {
      const rel = `+${((e.t - t0) / 1000).toFixed(1)}s`.padStart(8)
      return `${rel}  ${e.step}${e.detail ? ` - ${e.detail}` : ''}`
    })
    .join('\n')
}
