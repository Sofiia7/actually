import { describe, expect, it } from 'vitest'
import { buildMarketUrl, polymarketSearchUrl } from './polymarket'

describe('buildMarketUrl', () => {
  it('appends utm_source=actually to the slug', () => {
    expect(buildMarketUrl('will-x-happen')).toBe(
      'https://polymarket.com/event/will-x-happen?utm_source=actually',
    )
  })

  it('does not crash on empty slug', () => {
    expect(buildMarketUrl('')).toContain('utm_source=actually')
  })
})

describe('polymarketSearchUrl', () => {
  it('drops stopwords and keeps the terms that identify the story', () => {
    const url = polymarketSearchUrl('Trump put thousands of soldiers on Washington’s streets. They seldom stop crime')
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
    expect(q).toContain('trump')
    expect(q).toContain('soldiers')
    // "they" and "washington's" survive as content words only if they matter;
    // the point of the filter is that pure connective tissue does not.
    expect(q).not.toContain('they')
  })

  it('caps the query - a whole headline pasted into a search box matches nothing', () => {
    const url = polymarketSearchUrl('one two three four five six seven eight nine ten eleven twelve')
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
    expect(q.split(' ')).toHaveLength(6)
  })

  it('falls back to the raw headline when every word is filtered out', () => {
    const url = polymarketSearchUrl('and the of')
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
    expect(q).toBe('and the of')
  })

  it('points at the site root, not the /event path markets live under', () => {
    // POLYMARKET_BASE_URL already ends in /event, so reusing it verbatim
    // would send every no-match user to a 404.
    expect(polymarketSearchUrl('bitcoin surge')).toMatch(/^https:\/\/polymarket\.com\/search\?q=/)
  })

  it('percent-encodes the query so punctuation cannot break the URL', () => {
    // Punctuation only survives via the raw-headline fallback, which is
    // exactly the path where an unencoded & would truncate the query.
    const url = polymarketSearchUrl('the & of')
    expect(url).toContain('%26')
    expect(new URL(url).searchParams.get('q')).toBe('the & of')
  })
})
