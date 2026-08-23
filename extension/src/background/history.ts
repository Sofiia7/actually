import type { HistoryItem } from '../shared/types'
import type { MatchResult } from '@actually/core'
import { HISTORY_DEDUP_MINUTES, MAX_HISTORY_ITEMS, STORAGE_KEYS } from '../shared/constants'

export async function getHistory(): Promise<HistoryItem[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.history)
  return (data[STORAGE_KEYS.history] as HistoryItem[] | undefined) ?? []
}

export async function addToHistory(match: MatchResult, pageUrl: string): Promise<void> {
  const items = await getHistory()
  const pageDomain = safeHost(pageUrl)

  // Dedup: same pageUrl matched within DEDUP_MINUTES - skip
  const last = items[0]
  if (
    last &&
    last.pageUrl === pageUrl &&
    Date.now() - last.timestamp < HISTORY_DEDUP_MINUTES * 60_000
  ) {
    return
  }

  const item: HistoryItem = {
    marketId: match.market.id,
    marketSlug: match.market.slug,
    question: match.market.question,
    probability: match.freshPrice ?? match.probability,
    color: match.color,
    lowConfidence: match.lowConfidence,
    pageUrl,
    pageDomain,
    timestamp: Date.now(),
  }

  const next = [item, ...items].slice(0, MAX_HISTORY_ITEMS)
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: next })
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: [] })
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname
  } catch {
    return ''
  }
}
