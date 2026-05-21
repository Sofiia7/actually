import { useEffect, useState } from 'react'
import { getSettings } from '../../background/settings'

interface Props {
  /** Polymarket CLOB token id for the outcome we're charting */
  tokenId: string
  /** "blue" | "yellow" | "red" for line color (uses CSS vars) */
  color: 'blue' | 'yellow' | 'red'
  days?: number
}

interface PricePoint { t: number; p: number }

/**
 * 7-day price sparkline. Fetches Gamma /prices-history via the Worker
 * (`/history` proxy) and draws a single SVG polyline. No axes — this is
 * a glanceable mini-chart, not a full chart.
 */
export function Sparkline({ tokenId, color, days = 7 }: Props) {
  const [data, setData] = useState<PricePoint[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getSettings()
        if (!s.workerUrl || !s.workerSecret) return
        const params = new URLSearchParams({
          market: tokenId,
          interval: '1h',
          fidelity: '60',
        })
        // Polymarket's prices-history is by startTs/endTs unix seconds.
        const now = Math.floor(Date.now() / 1000)
        params.set('startTs', String(now - days * 86400))
        params.set('endTs', String(now))
        const res = await fetch(`${s.workerUrl}/history?${params}`, {
          headers: { 'X-Actually-Auth': s.workerSecret },
        })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as { history?: Array<{ t: number; p: number }> }
        if (cancelled) return
        setData(body.history ?? [])
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tokenId, days])

  if (error || data === null) {
    return (
      <div style={{ height: 40, opacity: 0.4, fontSize: 10, color: 'var(--text-mute)' }}>
        {error ? 'no history' : '…'}
      </div>
    )
  }
  if (data.length < 2) {
    return <div style={{ height: 40 }} />
  }

  const W = 312
  const H = 40
  const xs = data.map((d) => d.t)
  const ys = data.map((d) => d.p)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const xSpan = Math.max(1, xMax - xMin)
  const ySpan = Math.max(0.001, yMax - yMin)

  const pts = data
    .map((d) => {
      const x = ((d.t - xMin) / xSpan) * W
      const y = H - ((d.p - yMin) / ySpan) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const stroke = color === 'blue' ? 'var(--blue)' : color === 'yellow' ? 'var(--yellow)' : 'var(--red)'

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', width: '100%', height: 40 }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
