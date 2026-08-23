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
    // 4 char floor — long-form articles have long headlines, but hub/topic
    // pages on Reuters/AP often have short ones ("Iran War", "AI", "Tariffs")
    // which are perfectly valid match queries.
    if (text.length >= 4) {
      headline = text
      break
    }
  }
  // Fallbacks: <meta og:title>, then document.title (strip site suffix).
  if (!headline) {
    const og =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ??
      ''
    if (og.trim().length >= 4) headline = og.trim()
  }
  if (!headline && document.title) {
    // "Iran War | Reuters" → "Iran War"
    headline = document.title.split(/[|—–-]\s*/)[0]!.trim()
  }
  if (!headline || headline.length < 4) return null

  let bodyText = ''
  for (const sel of bodySelectors) {
    const els = document.querySelectorAll(sel)
    if (els.length > 0) {
      bodyText = Array.from(els)
        .map((el) => el.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .slice(0, 500)
      if (bodyText.length >= 40) break
      bodyText = ''
    }
  }
  // Hub/topic page fallback: gather visible card headlines (h2/h3) as
  // context. Markets care about topics, not body paragraphs.
  if (!bodyText) {
    const cards = document.querySelectorAll('h2, h3')
    bodyText = Array.from(cards)
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t.length >= 12)
      .slice(0, 12)
      .join('. ')
      .slice(0, 500)
  }
  // Last-ditch: meta description.
  if (!bodyText) {
    bodyText =
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ??
      document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ??
      ''
  }

  return {
    headline,
    bodyText,
    url: location.href,
    domain: location.hostname,
    // What the page says it is written in. News sites are reliable about this
    // ('ru' on rbc.ru, 'de' on spiegel.de), and it costs nothing to read —
    // the popup uses it to decide whether the text needs translating before
    // it can be matched against English market questions.
    pageLang: document.documentElement.getAttribute('lang') ?? '',
  }
}
