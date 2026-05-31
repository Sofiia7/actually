/**
 * Trade analytics blocks — Sparkline, Orderbook, ResolutionCard.
 *
 * Per spec §6, all three render between the matched-market card and the
 * order form in the Trade tab. Kept in one file because the components
 * are small, share styling primitives, and never get used independently.
 */
import React, { useEffect, useState } from 'react'
import { Etched } from '../components/Etched'
import type { PolyMarket } from '../../shared/types'
import { formatRelative } from '../../background/util'
import { orderbookSnapshotViaOffscreen, priceHistoryViaOffscreen } from '../ops'

// =============================================================
// Shared sub-section frame
// =============================================================
const Block: React.FC<{ children: React.ReactNode; title?: string }> = ({
  children,
  title,
}) => (
  <div
    style={{
      padding: '10px 12px',
      borderRadius: 8,
      background: 'rgba(255,255,255,.05)',
      border: '1px solid rgba(255,255,255,.22)',
    }}
  >
    {title && (
      <div style={{ marginBottom: 6 }}>
        <span className="label" style={{ color: 'rgba(35,45,70,.55)' }}>{title}</span>
      </div>
    )}
    {children}
  </div>
)

// =============================================================
// Sparkline — 7-day YES probability history, single SVG polyline.
// =============================================================
export const Sparkline: React.FC<{ tokenId: string; days?: number }> = ({
  tokenId,
  days = 7,
}) => {
  const [pts, setPts] = useState<Array<{ t: number; p: number }> | null>(null)

  useEffect(() => {
    let cancelled = false
    setPts(null)
    void (async () => {
      const data = await priceHistoryViaOffscreen(tokenId, days)
      if (!cancelled) setPts(data)
    })()
    return () => { cancelled = true }
  }, [tokenId, days])

  if (pts === null) {
    return <Block title="7-day trend"><Etched size={11} weight={300} color="rgba(35,45,70,.5)">loading…</Etched></Block>
  }
  if (pts.length < 2) {
    return <Block title="7-day trend"><Etched size={11} weight={300} color="rgba(35,45,70,.5)">no history yet</Etched></Block>
  }

  // Normalize to [0,1] viewBox so the SVG scales cleanly.
  const W = 320
  const H = 36
  const tMin = pts[0].t
  const tMax = pts[pts.length - 1].t
  const tRange = Math.max(1, tMax - tMin)
  const d = pts.map((pt, i) => {
    const x = ((pt.t - tMin) / tRange) * W
    const y = H - Math.max(0, Math.min(1, pt.p)) * H
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const first = pts[0].p
  const last = pts[pts.length - 1].p
  const deltaPct = Math.round((last - first) * 100)
  const sign = deltaPct >= 0 ? '+' : ''

  return (
    <Block title="7-day trend">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          <path d={d} fill="none" stroke="rgba(35,45,70,.7)" strokeWidth={1.25} />
        </svg>
        <Etched
          size={11.5}
          weight={400}
          style={{ whiteSpace: 'nowrap' }}
          color={deltaPct >= 0 ? 'rgba(30,110,60,.85)' : 'rgba(160,40,40,.85)'}
        >
          {sign}{deltaPct} pp
        </Etched>
      </div>
    </Block>
  )
}

// =============================================================
// Orderbook — best bid / best ask / spread.
// =============================================================
export const Orderbook: React.FC<{ tokenId: string }> = ({ tokenId }) => {
  const [snap, setSnap] = useState<{
    bestBid: number | null
    bestAsk: number | null
    spread: number | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setSnap(null)
    void (async () => {
      const s = await orderbookSnapshotViaOffscreen(tokenId)
      if (!cancelled) setSnap(s)
    })()
    return () => { cancelled = true }
  }, [tokenId])

  const fmt = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}¢`)

  return (
    <Block title="Orderbook">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 12 }}>
        <Cell label="Best bid" value={fmt(snap?.bestBid ?? null)} />
        <Cell label="Best ask" value={fmt(snap?.bestAsk ?? null)} />
        <Cell label="Spread" value={fmt(snap?.spread ?? null)} />
      </div>
    </Block>
  )
}

const Cell: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span style={{ fontSize: 10.5, color: 'rgba(35,45,70,.5)', letterSpacing: '.04em', textTransform: 'uppercase' }}>{label}</span>
    <span style={{ fontFamily: 'Marck Script', fontSize: 12.5, color: 'rgba(35,45,70,.85)' }}>{value}</span>
  </div>
)

// =============================================================
// ResolutionCard — date, source, rules excerpt with toggle.
// =============================================================
export const ResolutionCard: React.FC<{ market: PolyMarket }> = ({ market }) => {
  const [expanded, setExpanded] = useState(false)
  const end = market.endDate ? new Date(market.endDate) : null
  const rules = (market.description ?? '').trim()
  // First 2 lines / ~140 chars — whichever ends first.
  const collapsed = rules.split('\n').slice(0, 2).join(' ').slice(0, 160)
  const hasMore = rules.length > collapsed.length

  return (
    <Block title="Resolution">
      {end && (
        <Etched size={12} weight={400} style={{ display: 'block' }}>
          Resolves {end.toLocaleDateString()} · {formatRelative(end)}
        </Etched>
      )}
      {market.resolutionSource && (
        <Etched size={11} weight={300} color="rgba(35,45,70,.55)">
          Source: {market.resolutionSource}
        </Etched>
      )}
      {rules && (
        <div style={{ marginTop: 6 }}>
          <Etched size={11.5} weight={300} color="rgba(35,45,70,.7)" style={{ lineHeight: 1.4 }}>
            {expanded ? rules : collapsed}{!expanded && hasMore ? '…' : ''}
          </Etched>
          {hasMore && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              style={{
                appearance: 'none', background: 'none', border: 0, padding: 0,
                cursor: 'pointer', font: 'inherit', color: 'rgba(35,80,160,.85)',
                fontSize: 11, marginTop: 4,
              }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </Block>
  )
}

// =============================================================
// MarketAnalytics — bundles the three blocks so callers don't
// re-derive YES-token id or thread three components by hand.
// =============================================================
export const MarketAnalytics: React.FC<{
  market: PolyMarket
  yesTokenId: string | undefined
}> = ({ market, yesTokenId }) => (
  <>
    {yesTokenId && <Sparkline tokenId={yesTokenId} />}
    {yesTokenId && <Orderbook tokenId={yesTokenId} />}
    <ResolutionCard market={market} />
  </>
)
