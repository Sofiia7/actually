/**
 * Popup-side operations.
 *
 * The heavy match/refresh/embedding pipeline runs in the offscreen document
 * (see src/offscreen/offscreen.ts), reached via popup_new/ops.ts. The only
 * thing the popup needs to do directly is read the active tab's article,
 * which requires the `activeTab` + `scripting` permissions available in the
 * popup context.
 */
import type { ArticleData } from '../shared/types'
import { extractFromPage } from '../background/extractor'

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
