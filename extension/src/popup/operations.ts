/**
 * Popup-side operations.
 *
 * Heavy work — ML model loading, embedding, market cache refresh, article
 * matching — runs in the popup context (which has `window`, `document`, no
 * MV3 service-worker lifetime limits, and is allowed to use dynamic imports).
 *
 * The Service Worker is only used for cross-context concerns: install id,
 * telemetry batching, and lifecycle hooks. All embedding-touching logic
 * lives here.
 */
import type { ArticleData, MatchResult, Settings } from '../shared/types'
import { getCacheStatus, refreshMarketCache } from '../background/cache'
import { findMatch } from '../background/matcher'
import { extractFromPage } from '../background/extractor'
import { fetchLivePrice } from '../background/polymarket'
import { addToHistory } from '../background/history'
import { trackEvent } from '../background/telemetry'
import { CACHE_TTL_MINUTES } from '../shared/constants'

export async function runRefresh(
  settings: Settings,
): Promise<{ added: number; reused: number; removed: number }> {
  if (!settings.workerUrl || !settings.workerSecret) {
    throw new Error('no_keys')
  }
  return refreshMarketCache(
    settings.embeddingProvider,
    settings.workerUrl,
    settings.workerSecret,
  )
}

export async function extractActiveTabArticle(): Promise<ArticleData | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFromPage,
    })
    return (results[0]?.result as ArticleData | null) ?? null
  } catch {
    return null
  }
}

export async function runMatch(settings: Settings): Promise<{
  match: MatchResult | null
  reason?: string
  article?: ArticleData
}> {
  if (!settings.workerUrl || !settings.workerSecret) {
    return { match: null, reason: 'no_keys' }
  }

  void trackEvent('check_page_clicked', settings)

  // Lazy TTL refresh: if cache is stale, kick off refresh in background
  // (non-blocking — we want the user to see the current cache's best match
  // immediately). The fresh data lands on the next match attempt.
  void maybeRefreshStaleCache(settings)

  const article = await extractActiveTabArticle()
  if (!article) {
    void trackEvent('no_match', settings, { reason: 'no_article' })
    return { match: null, reason: 'no_article' }
  }

  let match: MatchResult | null
  try {
    match = await findMatch(article.headline, article.bodyText, settings)
  } catch (err) {
    void trackEvent('no_match', settings, { reason: 'match_error' })
    return { match: null, reason: `match_error:${err}`, article }
  }

  if (!match) {
    void trackEvent('no_match', settings, { reason: 'below_floor' })
    return { match: null, reason: 'below_floor', article }
  }

  void trackEvent(match.lowConfidence ? 'match_lowconf' : 'match_shown', settings, {
    color: match.color,
    confidence_bucket: Math.floor(match.confidence * 10) / 10,
  })

  // Live price refresh — non-fatal
  const tokenId = match.market.clobTokenIds[0]
  if (tokenId) {
    try {
      const live = await fetchLivePrice(tokenId, settings.workerUrl, settings.workerSecret)
      if (live !== null) match.freshPrice = live
    } catch {
      /* ignore */
    }
  }

  await addToHistory(match, article.url)
  return { match, article }
}

let inflightRefresh: Promise<unknown> | null = null

/**
 * Trigger a background cache refresh if the cache is older than the TTL,
 * deduped so multiple concurrent matches don't kick off multiple refreshes.
 * The promise is fire-and-forget — callers should `void` it.
 */
export async function maybeRefreshStaleCache(settings: Settings): Promise<void> {
  if (inflightRefresh) return
  const status = await getCacheStatus()
  const ageMin = status.lastUpdated > 0 ? (Date.now() - status.lastUpdated) / 60_000 : Infinity
  const isStale = status.count === 0 || ageMin > CACHE_TTL_MINUTES
  if (!isStale) return
  inflightRefresh = refreshMarketCache(
    settings.embeddingProvider,
    settings.workerUrl,
    settings.workerSecret,
  )
    .catch(() => undefined)
    .finally(() => {
      inflightRefresh = null
    })
}
