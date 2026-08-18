/**
 * Local activity log — every buy, sell and redeem the user makes from the
 * extension, kept in chrome.storage.local.
 *
 * Why this exists at all: Polymarket's positions API only reports what you
 * hold RIGHT NOW. The moment a sell fills or a redeem lands, the position
 * disappears from it — so a user who sold a position and then looked for it
 * saw nothing at all, with no way to tell "it sold" from "it never existed".
 * The CLOB does keep order history behind an authenticated endpoint, but that
 * is a network round-trip that fails exactly when the wallet session is gone,
 * which is precisely when the user is trying to reconstruct what happened.
 *
 * Failures are logged too, deliberately: "I clicked sell and something went
 * wrong" is a record worth keeping, and it's the only way the log can be read
 * as a complete account of what the user did rather than a highlight reel.
 */
import type { TradeLogItem } from '../shared/types'
import { MAX_TRADE_LOG_ITEMS, STORAGE_KEYS } from '../shared/constants'

export async function getTradeLog(): Promise<TradeLogItem[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.tradeLog)
  const items = data[STORAGE_KEYS.tradeLog] as TradeLogItem[] | undefined
  return Array.isArray(items) ? items : []
}

/**
 * Append one entry. Never throws: a storage failure must not turn a
 * successful trade into a failed one at the call site, so callers can
 * `void logTrade(...)` on the happy path.
 */
export async function logTrade(entry: Omit<TradeLogItem, 'id' | 'timestamp'>): Promise<void> {
  try {
    const items = await getTradeLog()
    const item: TradeLogItem = {
      ...entry,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }
    const next = [item, ...items].slice(0, MAX_TRADE_LOG_ITEMS)
    await chrome.storage.local.set({ [STORAGE_KEYS.tradeLog]: next })
  } catch {
    // Logging is best-effort by design — see the doc comment above.
  }
}

export async function clearTradeLog(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.tradeLog]: [] })
}
