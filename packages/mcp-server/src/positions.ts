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
  title?: string
  slug?: string
}

/**
 * Positions for a given on-chain address (the caller's derived Safe), read
 * directly from Polymarket's public, unauthenticated data-api — no worker
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
    title: p.title ?? '',
    slug: p.slug ?? '',
  }))
}
