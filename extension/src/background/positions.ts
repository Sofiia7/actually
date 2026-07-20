import type { Position } from '../shared/types'

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
  redeemable?: boolean
  title?: string
  slug?: string
}

/**
 * Positions for the connected wallet's Safe address, read directly from
 * Polymarket's public, unauthenticated data-api — no worker hop, no CLOB
 * creds needed. Mirrors packages/mcp-server/src/positions.ts.
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
    redeemable: p.redeemable ?? false,
    title: p.title ?? '',
    slug: p.slug ?? '',
  }))
}
