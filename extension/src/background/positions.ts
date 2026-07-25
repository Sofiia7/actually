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
 * Positions for the connected wallet's Safe address, read via our Worker's
 * /clob/positions/<address> proxy rather than data-api.polymarket.com
 * directly — a direct browser fetch would send the user's real IP and Safe
 * address straight to Polymarket, bypassing the Cloudflare-mediation this
 * extension's privacy policy promises for every other Polymarket call. No
 * CLOB creds needed either way (this is a public lookup by address).
 */
export async function fetchPositions(address: string, workerUrl: string, workerSecret: string): Promise<Position[]> {
  const res = await fetch(`${workerUrl}/clob/positions/${address}`, {
    headers: { 'X-Actually-Auth': workerSecret },
  })
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
