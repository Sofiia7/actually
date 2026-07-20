import React from 'react'
import { IceCard } from './IceCard'
import { Etched } from './Etched'
import { LinkAction } from './LinkAction'
import type { OpenOrderSummary, Position } from '../../shared/types'

export interface PositionsPanelProps {
  positions: Position[]
  openOrders: OpenOrderSummary[]
  loading: boolean
  cancellingId: string | null
  onCancelOrder: (orderId: string) => void
  onRefresh: () => void
}

const fmtUsd = (v: number) => `$${v.toFixed(2)}`
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

/**
 * Read-only view of the connected wallet's current Polymarket positions and
 * resting orders — previously the only way to see either was polymarket.com
 * directly, since the extension only ever showed the order you'd just placed
 * in the current popup session.
 */
export const PositionsPanel: React.FC<PositionsPanelProps> = ({
  positions,
  openOrders,
  loading,
  cancellingId,
  onCancelOrder,
  onRefresh,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Etched size={11.5} weight={400} color="rgba(35,45,70,.6)">
          Your positions & open orders
        </Etched>
        <LinkAction onClick={onRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</LinkAction>
      </div>

      {positions.length === 0 && openOrders.length === 0 && !loading && (
        <Etched size={11.5} weight={300} color="rgba(35,45,70,.45)">
          No open positions or resting orders.
        </Etched>
      )}

      {positions.map((p) => (
        <IceCard key={p.tokenId} pct={p.curPrice * 100} intensity={0.6} padding="8px 11px" borderRadius={8}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Etched size={12} weight={400} style={{ flex: 1, minWidth: 0 }}>
              {p.title || p.outcome} <span style={{ opacity: 0.6 }}>· {p.outcome}</span>
            </Etched>
            {p.redeemable && (
              <Etched size={10.5} weight={400} color="rgba(30,110,60,.9)">
                redeemable
              </Etched>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
            <Etched size={11} weight={300} color="rgba(35,45,70,.6)">
              {p.size.toFixed(2)} shares @ {(p.avgPrice * 100).toFixed(1)}¢ · now {fmtUsd(p.currentValue)}
            </Etched>
            <Etched size={11} weight={400} color={p.cashPnl >= 0 ? 'rgba(30,110,60,.9)' : 'rgba(160,40,40,.9)'}>
              {fmtUsd(p.cashPnl)} ({fmtPct(p.percentPnl)})
            </Etched>
          </div>
        </IceCard>
      ))}

      {openOrders.map((o) => (
        <IceCard key={o.orderId} plain padding="8px 11px" borderRadius={8}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Etched size={11} weight={300} color="rgba(35,45,70,.65)" style={{ flex: 1, minWidth: 0 }}>
              {o.side} {o.sizeMatched}/{o.originalSize} @ {(parseFloat(o.price) * 100).toFixed(1)}¢ · {o.status}
            </Etched>
            <LinkAction onClick={() => onCancelOrder(o.orderId)}>
              {cancellingId === o.orderId ? 'Cancelling…' : 'Cancel'}
            </LinkAction>
          </div>
        </IceCard>
      ))}
    </div>
  )
}
