import React, { useEffect, useRef, useState } from 'react'
import { IceCard } from './IceCard'
import { Etched } from './Etched'
import { LinkAction } from './LinkAction'
import { SellTicket } from '../SellTicket'
import { redeemPositionViaOffscreen } from '../ops'
import type { OpenOrderSummary, Position } from '../../shared/types'

/** Redeem failures the user can actually do something about. */
export function humanRedeemError(raw: string): string {
  if (/not_yet_redeemable/.test(raw)) {
    return "Polymarket doesn't consider this resolved yet — try again once it settles."
  }
  if (/position_not_found/.test(raw)) return 'That position is no longer held — refresh.'
  if (/no_wallet/.test(raw)) return 'Wallet session expired — reconnect and try again.'
  if (/worker_not_configured/.test(raw)) return 'Set the Worker URL and secret in Settings first.'
  if (/wc_provider_unsupported_method|personal_sign/i.test(raw)) {
    return "Your wallet didn't grant permission to sign this. Reconnect and approve the full request."
  }
  if (/relayer_state/.test(raw)) {
    return 'Polymarket\'s relayer rejected the transaction. Nothing was redeemed — try again shortly.'
  }
  if (/user rejected|user disapproved|rejected/i.test(raw)) return 'You declined the signature in your wallet.'
  return raw
}

export interface PositionsPanelProps {
  positions: Position[]
  openOrders: OpenOrderSummary[]
  loading: boolean
  cancellingId: string | null
  onCancelOrder: (orderId: string) => void
  onRefresh: () => void
  /** Set when the last positions/open-orders fetch failed — shown instead of silently rendering an empty list. */
  portfolioError?: string | null
  /** Set when the last cancel attempt failed — cleared on the next successful cancel or refresh. */
  cancelError?: string | null
}

const fmtUsd = (v: number) => `$${v.toFixed(2)}`
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
const shortenMarketId = (id: string) => (id.length > 10 ? `${id.slice(0, 10)}…` : id)

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
  portfolioError,
  cancelError,
}) => {
  // Which position's sell ticket is open. One at a time, by tokenId — an
  // expanded ticket per row would let two sells be half-filled in at once.
  const [sellingTokenId, setSellingTokenId] = useState<string | null>(null)
  // Confirmation for a sell that has already closed its ticket. Held here
  // because the panel outlives the ticket — see SellTicket's onDone.
  const [sellNotice, setSellNotice] = useState<string | null>(null)
  const lagRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (lagRefreshRef.current) clearTimeout(lagRefreshRef.current)
    },
    [],
  )

  const [redeemingId, setRedeemingId] = useState<string | null>(null)

  async function onRedeem(conditionId: string) {
    // A LinkAction is a plain <a> with no native disabled state, and this one
    // signs an on-chain call — guard synchronously so a double-click can't
    // submit two relayer transactions for the same position.
    if (redeemingId) return
    setRedeemingId(conditionId)
    setSellNotice(null)
    try {
      const r = await redeemPositionViaOffscreen(conditionId)
      setSellNotice(
        r.ok
          ? `Redeemed${r.transactionId ? ` · ${r.transactionId.slice(0, 10)}…` : ''} — the payout lands in your Polymarket balance.`
          : `Redeem failed: ${humanRedeemError(r.error ?? 'unknown_error')}`,
      )
    } catch (err) {
      setSellNotice(`Redeem failed: ${String(err)}`)
    } finally {
      setRedeemingId(null)
      onRefresh()
      if (lagRefreshRef.current) clearTimeout(lagRefreshRef.current)
      lagRefreshRef.current = setTimeout(onRefresh, 5000)
    }
  }

  function onSold(message: string) {
    setSellNotice(message)
    setSellingTokenId(null)
    onRefresh()
    // Polymarket's positions API is eventually consistent: a fill is accepted
    // by the CLOB before it shows up here, so the immediate refresh above
    // usually returns the pre-sale numbers and the row looks untouched. Come
    // back once more after the lag rather than leaving the user staring at a
    // position they just sold.
    if (lagRefreshRef.current) clearTimeout(lagRefreshRef.current)
    lagRefreshRef.current = setTimeout(onRefresh, 5000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Etched size={11.5} weight={400} color="rgba(35,45,70,.6)">
          Your positions & open orders
        </Etched>
        <LinkAction onClick={onRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</LinkAction>
      </div>

      {portfolioError && (
        <Etched size={11.5} weight={300} color="rgba(160,40,40,.9)">
          Couldn't refresh: {portfolioError}. Showing the last known state.
        </Etched>
      )}

      {cancelError && (
        <Etched size={11.5} weight={300} color="rgba(160,40,40,.9)">
          Cancel failed: {cancelError}
        </Etched>
      )}

      {sellNotice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <Etched size={11.5} weight={300} color="rgba(30,110,60,.9)" style={{ flex: 1, minWidth: 0 }}>
            {sellNotice}
          </Etched>
          <LinkAction onClick={() => setSellNotice(null)}>Dismiss</LinkAction>
        </div>
      )}

      {positions.length === 0 && openOrders.length === 0 && !loading && !portfolioError && (
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

          {/* A resolved market no longer trades — offering Sell there would
              only ever produce a CLOB rejection. Those are redeemed instead. */}
          {p.redeemable ? (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <LinkAction onClick={() => void onRedeem(p.conditionId)}>
                {redeemingId === p.conditionId ? 'Redeeming…' : 'Redeem →'}
              </LinkAction>
              <Etched size={10.5} weight={300} color="rgba(35,45,70,.5)">
                Market resolved · no gas needed
              </Etched>
            </div>
          ) : sellingTokenId === p.tokenId ? (
            <SellTicket position={p} onDone={onSold} onCancel={() => setSellingTokenId(null)} />
          ) : (
            <div style={{ marginTop: 5 }}>
              <LinkAction onClick={() => setSellingTokenId(p.tokenId)}>Sell →</LinkAction>
            </div>
          )}
        </IceCard>
      ))}

      {openOrders.map((o) => (
        <IceCard key={o.orderId} plain padding="8px 11px" borderRadius={8}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Etched size={11} weight={300} color="rgba(35,45,70,.65)" style={{ flex: 1, minWidth: 0 }}>
              {o.side} {o.outcome} · market {shortenMarketId(o.marketId)}
              <br />
              {o.sizeMatched}/{o.originalSize} @ {(parseFloat(o.price) * 100).toFixed(1)}¢ · {o.status}
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
