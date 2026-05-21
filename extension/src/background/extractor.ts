import type { ArticleData } from '../shared/types'

/**
 * Runs in the page context via chrome.scripting.executeScript({ func }).
 * No imports allowed — everything must be inlined.
 */
export function extractFromPage(): ArticleData | null {
  const headlineSelectors = [
    'h1[data-testid="headline"]',
    'h1.article-header__title',
    'h1[class*="ArticleHeader"]',
    'h1[class*="headline"]',
    'h1[class*="Headline"]',
    '[data-testid="article-headline"]',
    'h1.article__title',
    'article h1',
    'main h1',
    'h1',
  ]

  const bodySelectors = [
    '[data-testid="article-body"]',
    '[class*="ArticleBody"]',
    '[class*="article-body"]',
    '[class*="StoryBody"]',
    'article p',
    'main p',
  ]

  let headline = ''
  for (const sel of headlineSelectors) {
    const el = document.querySelector(sel)
    const text = el?.textContent?.trim() ?? ''
    if (text.length > 20) {
      headline = text
      break
    }
  }
  if (!headline) return null

  let bodyText = ''
  for (const sel of bodySelectors) {
    const els = document.querySelectorAll(sel)
    if (els.length > 0) {
      bodyText = Array.from(els)
        .map((el) => el.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .slice(0, 500)
      break
    }
  }

  return {
    headline,
    bodyText,
    url: location.href,
    domain: location.hostname,
  }
}
