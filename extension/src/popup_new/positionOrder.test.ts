import { describe, expect, it } from 'vitest'
import { orderPositionsByRecentActivity } from './positionOrder'
import type { Position, TradeLogItem } from '../shared/types'

function pos(over: Partial<Position>): Position {
  return {
    tokenId: 't',
    conditionId: 'c',
    size: 1,
    avgPrice: 0.5,
    curPrice: 0.5,
    currentValue: 0.5,
    cashPnl: 0,
    percentPnl: 0,
    outcome: 'Yes',
    redeemable: false,
    title: 'A market',
    slug: 'a-market',
    outcomeIndex: 0,
    negativeRisk: false,
    ...over,
  }
}

function entry(over: Partial<TradeLogItem>): TradeLogItem {
  return {
    id: 'i',
    timestamp: 1_000,
    kind: 'BUY',
    status: 'placed',
    question: 'A market',
    ...over,
  }
}

const slugs = (ps: Position[]) => ps.map((p) => p.slug)

describe('orderPositionsByRecentActivity', () => {
  it('puts the most recently traded position first, whatever its share count', () => {
    // The case that prompted this: a 6-share buy made a minute ago sat under
    // a 129-share position from weeks earlier, because the data-api sorts by
    // size and nothing here re-sorted it.
    const positions = [
      pos({ slug: 'google-best-ai', title: 'Google best AI', size: 129 }),
      pos({ slug: 'china-taiwan', title: 'China invades Taiwan', size: 14 }),
      pos({ slug: 'iran-blockade', title: 'Iran blockade', size: 6, outcome: 'No' }),
    ]
    const log = [
      entry({ timestamp: 3_000, marketSlug: 'iran-blockade', question: 'Iran blockade', outcome: 'No' }),
      entry({ timestamp: 2_000, marketSlug: 'china-taiwan', question: 'China invades Taiwan', outcome: 'Yes' }),
      entry({ timestamp: 1_000, marketSlug: 'google-best-ai', question: 'Google best AI', outcome: 'Yes' }),
    ]
    expect(slugs(orderPositionsByRecentActivity(positions, log))).toEqual([
      'iran-blockade',
      'china-taiwan',
      'google-best-ai',
    ])
  })

  it('dates a position by its NEWEST entry, not its first', () => {
    const positions = [pos({ slug: 'old-buy-new-sell' }), pos({ slug: 'one-recent-buy' })]
    const log = [
      entry({ timestamp: 5_000, kind: 'SELL', marketSlug: 'old-buy-new-sell', outcome: 'Yes' }),
      entry({ timestamp: 4_000, marketSlug: 'one-recent-buy', outcome: 'Yes' }),
      entry({ timestamp: 1_000, marketSlug: 'old-buy-new-sell', outcome: 'Yes' }),
    ]
    expect(slugs(orderPositionsByRecentActivity(positions, log))).toEqual(['old-buy-new-sell', 'one-recent-buy'])
  })

  it('counts failed attempts — a redeem that just 401ed is exactly what the user came back to look at', () => {
    const positions = [pos({ slug: 'quiet' }), pos({ slug: 'just-failed' })]
    const log = [
      entry({ timestamp: 9_000, kind: 'REDEEM', status: 'failed', marketSlug: 'just-failed', outcome: 'Yes' }),
      entry({ timestamp: 8_000, marketSlug: 'quiet', outcome: 'Yes' }),
    ]
    expect(slugs(orderPositionsByRecentActivity(positions, log))).toEqual(['just-failed', 'quiet'])
  })

  it('keeps Yes and No on the same market apart — selling one must not re-date the other', () => {
    const positions = [
      pos({ slug: 'same-market', outcome: 'Yes', tokenId: 'yes' }),
      pos({ slug: 'same-market', outcome: 'No', tokenId: 'no' }),
    ]
    const log = [entry({ timestamp: 7_000, marketSlug: 'same-market', outcome: 'No' })]
    expect(orderPositionsByRecentActivity(positions, log).map((p) => p.tokenId)).toEqual(['no', 'yes'])
  })

  it('falls back to the market question when the log entry has no slug', () => {
    // marketSlug is documented as "when known" — entries written before the
    // slug was resolved would otherwise never match anything.
    const positions = [pos({ slug: 'a', title: 'Older' }), pos({ slug: 'b', title: 'Logged by question' })]
    const log = [entry({ timestamp: 6_000, question: 'Logged by question', outcome: 'Yes' })]
    expect(slugs(orderPositionsByRecentActivity(positions, log))).toEqual(['b', 'a'])
  })

  it('leaves positions the log has never heard of below the dated ones, in the order the API sent them', () => {
    // Bought on polymarket.com, or older than the log's 100-item ceiling.
    // Their incoming order is size-descending and that is the best we know.
    const positions = [pos({ slug: 'big-unknown', size: 500 }), pos({ slug: 'small-unknown', size: 2 }), pos({ slug: 'logged', size: 1 })]
    const log = [entry({ timestamp: 4_000, marketSlug: 'logged', outcome: 'Yes' })]
    expect(slugs(orderPositionsByRecentActivity(positions, log))).toEqual(['logged', 'big-unknown', 'small-unknown'])
  })

  it('does not let a shared question date an unrelated market — Polymarket recycles titles across recurring events', () => {
    // "Ethereum Up or Down" runs every five minutes under the same question
    // and a different slug. A question-keyed match on an entry that HAS a
    // slug would date every round of it from whichever one was traded.
    const positions = [
      pos({ slug: 'eth-updown-0900', title: 'Ethereum Up or Down' }),
      pos({ slug: 'eth-updown-0905', title: 'Ethereum Up or Down' }),
    ]
    const log = [entry({ timestamp: 5_000, marketSlug: 'eth-updown-0905', question: 'Ethereum Up or Down', outcome: 'Yes' })]
    const ordered = orderPositionsByRecentActivity(positions, log)
    expect(slugs(ordered)).toEqual(['eth-updown-0905', 'eth-updown-0900'])
  })

  it('is a no-op on an empty log — a fresh install must still see its positions', () => {
    const positions = [pos({ slug: 'x' }), pos({ slug: 'y' })]
    expect(slugs(orderPositionsByRecentActivity(positions, []))).toEqual(['x', 'y'])
  })

  it('does not mutate the array it was given', () => {
    const positions = [pos({ slug: 'x' }), pos({ slug: 'y' })]
    orderPositionsByRecentActivity(positions, [entry({ timestamp: 1, marketSlug: 'y', outcome: 'Yes' })])
    expect(slugs(positions)).toEqual(['x', 'y'])
  })
})
