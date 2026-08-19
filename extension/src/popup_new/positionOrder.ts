/**
 * Ordering for the positions list.
 *
 * Polymarket's data-api returns positions sorted by SIZE, descending — its
 * default is `sortBy=TOKENS&sortDirection=DESC` and this extension never
 * overrode it. That reads as arbitrary from the user's side: the position
 * they just opened lands wherever its share count happens to fall, which for
 * a small first trade is the bottom of the list, under markets they last
 * touched weeks ago.
 *
 * The obvious fix — ask the API for newest-first — isn't available: a
 * position object carries no timestamp at all (28 fields, none temporal
 * except the market's own `endDate`), and `sortBy` offers no recency option.
 * So recency comes from the one record that does have it: the local trade
 * log, which timestamps every buy, sell and redeem made through the popup.
 *
 * Positions with no log entry — bought on polymarket.com, or older than the
 * log's 100-item ceiling — keep their incoming relative order and sit below
 * the ones we can date. Guessing at their age would be worse than admitting
 * we don't know it.
 */
import type { Position, TradeLogItem } from '../shared/types'

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase()

/**
 * How a position and a log entry are matched up.
 *
 * Slug is the reliable identifier, but `marketSlug` is documented as "when
 * known" and older entries can lack it — hence a question-text fallback. That
 * fallback is deliberately narrow: it indexes ONLY the slug-less entries.
 * Indexing every entry under its question too would let one market's trade
 * date an unrelated position whenever two markets share a title (Polymarket
 * recycles question text across recurring events — "Ethereum Up or Down" runs
 * every five minutes), and a wrong date here silently reorders the list.
 *
 * Both keys are qualified by outcome: Yes and No on the same market are two
 * separate rows, and selling one must not re-date the other.
 */
const slugKey = (slug: string | undefined, outcome: string | undefined) => `s:${norm(slug)}|${norm(outcome)}`
const questionKey = (question: string | undefined, outcome: string | undefined) =>
  `q:${norm(question)}|${norm(outcome)}`

/**
 * Positions ordered by the most recent thing the user did to them, newest
 * first.
 *
 * Failed and unknown-status entries count. A redeem that 401'd a minute ago
 * is precisely the row the user is looking for when they reopen the popup,
 * and demoting it because it didn't succeed hides the evidence of what just
 * happened. The log is a record of what was DONE, not of what worked.
 */
export function orderPositionsByRecentActivity(positions: Position[], log: TradeLogItem[]): Position[] {
  const bySlug = new Map<string, number>()
  const byQuestion = new Map<string, number>()
  for (const entry of log) {
    const into = norm(entry.marketSlug) ? bySlug : byQuestion
    const key = norm(entry.marketSlug)
      ? slugKey(entry.marketSlug, entry.outcome)
      : questionKey(entry.question, entry.outcome)
    const seen = into.get(key)
    if (seen === undefined || entry.timestamp > seen) into.set(key, entry.timestamp)
  }

  const touchedAt = (p: Position): number => {
    const bySlugHit = norm(p.slug) ? bySlug.get(slugKey(p.slug, p.outcome)) : undefined
    // The question map only ever holds slug-less entries, so consulting it
    // after a slug miss costs nothing and recovers those older records.
    return bySlugHit ?? byQuestion.get(questionKey(p.title, p.outcome)) ?? -1
  }

  // Decorate-sort-undecorate: Array#sort is stable in every engine this ships
  // to, but the index tiebreak states the intent outright — undated positions
  // must come out in exactly the order the API gave them (size, descending),
  // not in some order that happens to fall out of the comparator.
  return positions
    .map((position, index) => ({ position, index, at: touchedAt(position) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((row) => row.position)
}
