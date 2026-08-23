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
  /** 0 or 1 - which binary outcome slot this position occupies. Needed to redeem neg-risk positions. */
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

/**
 * Positions for a given on-chain address (the caller's derived Safe), read
 * directly from Polymarket's public, unauthenticated data-api - no worker
 * hop needed, same as the extension's `/clob/proxy/<eoa>` data-api calls.
 */
export async function fetchPositions(address: string): Promise<Position[]> {
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${address}`)
  if (!res.ok) throw new Error(`positions_fetch_failed:${res.status}`)
  const raw = (await res.json()) as RawPosition[]
  return raw.map((p) => ({
    tokenId: p.asset ?? '',
    conditionId: p.conditionId ?? '',
    size: p.size ?? 0,
    avgPrice: p.avgPrice ?? 0,
    curPrice: p.curPrice ?? 0,
    currentValue: p.currentValue ?? 0,
    cashPnl: p.cashPnl ?? 0,
    percentPnl: p.percentPnl ?? 0,
    outcome: p.outcome ?? '',
    outcomeIndex: p.outcomeIndex ?? 0,
    negativeRisk: p.negativeRisk ?? false,
    redeemable: p.redeemable ?? false,
    title: p.title ?? '',
    slug: p.slug ?? '',
  }))
}
