import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getSettings } from '../../background/settings'

interface Props {
  tokenId: string
}

interface BookSnapshot {
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
}

/**
 * Best bid / ask / spread for a market. Fetches through the Worker
 * `/orderbook` proxy (no signer needed — orderbook is public).
 */
export function Orderbook({ tokenId }: Props) {
  const { t } = useTranslation()
  const [snap, setSnap] = useState<BookSnapshot | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getSettings()
        if (!s.workerUrl || !s.workerSecret) return
        const res = await fetch(
          `${s.workerUrl}/orderbook?token_id=${encodeURIComponent(tokenId)}`,
          { headers: { 'X-Actually-Auth': s.workerSecret } },
        )
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as {
          bids?: Array<{ price: string; size: string }>
          asks?: Array<{ price: string; size: string }>
        }
        if (cancelled) return
        const asks = (body.asks ?? [])
          .map((l) => Number(l.price))
          .filter(Number.isFinite)
          .sort((a, b) => a - b)
        const bids = (body.bids ?? [])
          .map((l) => Number(l.price))
          .filter(Number.isFinite)
          .sort((a, b) => b - a)
        const bestAsk = asks[0] ?? null
        const bestBid = bids[0] ?? null
        const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null
        setSnap({ bestBid, bestAsk, spread })
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tokenId])

  if (error) return null
  if (!snap) return <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>…</div>

  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-dim)' }}>
      <span>Bid {fmtCents(snap.bestBid)}</span>
      <span>Ask {fmtCents(snap.bestAsk)}</span>
      <span>
        {t('trade.spread')} {fmtCents(snap.spread)}
      </span>
    </div>
  )
}

function fmtCents(v: number | null): string {
  if (v == null) return '—'
  return `${Math.round(v * 100)}¢`
}
