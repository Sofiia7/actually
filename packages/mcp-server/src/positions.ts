export interface Position {
  tokenId: string
  conditionId: string
  size: number
  avgPrice: number
  curPrice: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  outcome: string
  /** 0 or 1 - which binary outcome slot this position occupies. Needed to
   * redeem neg-risk positions. -1 when the source data omitted it - never
   * assume that means slot 0 (2026-09-08 audit F09). */
  outcomeIndex: number
  /** True for neg-risk (multi-outcome) markets - redeem_position needs this to pick the right contract. */
  negativeRisk: boolean
  /** True once the market has resolved and this position can be redeemed for pUSD. */
  redeemable: boolean
  title: string
  slug: string
}

interface RawPosition {
  asset?: string
  conditionId?: string
  size?: number
  avgPrice?: number
  curPrice?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  outcome?: string
  outcomeIndex?: number
  negativeRisk?: boolean
  redeemable?: boolean
  title?: string
  slug?: string
}

function mapPosition(p: RawPosition): Position {
  return {
    tokenId: p.asset ?? '',
    conditionId: p.conditionId ?? '',
    size: p.size ?? 0,
    avgPrice: p.avgPrice ?? 0,
    curPrice: p.curPrice ?? 0,
    currentValue: p.currentValue ?? 0,
    cashPnl: p.cashPnl ?? 0,
    percentPnl: p.percentPnl ?? 0,
    outcome: p.outcome ?? '',
    // -1, not 0: a missing outcomeIndex must FAIL buildRedeemTransaction's
    // validation (invalid_outcome_index), not silently redeem outcome slot
    // 0 (YES) for what might be a NO position (2026-09-08 audit F09).
    // Matches the extension's own positions.ts.
    outcomeIndex: p.outcomeIndex ?? -1,
    negativeRisk: p.negativeRisk ?? false,
    redeemable: p.redeemable ?? false,
    title: p.title ?? '',
    slug: p.slug ?? '',
  }
}

// The API defaults to limit=100, offset=0, sizeThreshold=1 share when these
// are omitted - silently hiding both an active user's positions past the
// first 100 and any dust remainder under one share (redeem_position then
// searches this same incomplete list and can wrongly report
// position_not_found for a position that genuinely exists - 2026-09-08
// audit F16). PAGE_LIMIT is a request size, not a promise the API honors it
// exactly; pagination below is driven by how many rows actually come back,
// not by this number.
const PAGE_LIMIT = 500
// A real portfolio is never going to need more than this many pages: a
// bound so a misbehaving API (e.g. one that always returns a full page)
// can't turn this into an infinite loop.
const MAX_PAGES = 20

/**
 * Positions for a given on-chain address (the caller's derived Safe), read
 * directly from Polymarket's public, unauthenticated data-api - no worker
 * hop needed, same as the extension's `/clob/proxy/<eoa>` data-api calls.
 * Pages through the FULL portfolio rather than trusting the API's default
 * single 100-position page (2026-09-08 audit F16).
 */
export async function fetchPositions(address: string): Promise<Position[]> {
  const all: Position[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT
    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${address}&limit=${PAGE_LIMIT}&offset=${offset}&sizeThreshold=0`,
    )
    if (!res.ok) throw new Error(`positions_fetch_failed:${res.status}`)
    const raw = (await res.json()) as RawPosition[]
    all.push(...raw.map(mapPosition))
    if (raw.length < PAGE_LIMIT) break
  }
  return all
}
