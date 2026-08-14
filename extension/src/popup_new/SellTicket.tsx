import React, { useEffect, useState } from 'react'
import { Etched } from './components/Etched'
import { GlassButton } from './components/GlassButton'
import { minOrderShares } from '@actually/core'
import type { Position } from '../shared/types'
import { orderbookSnapshotViaOffscreen, sellOrderViaOffscreen } from './ops'

/** Worst-acceptable slippage below the bid for a market (FOK) sell. Mirrors
 * the buy ticket's CAP_PCT, in the opposite direction. */
const FLOOR_PCT = 0.02

export interface SellTicketProps {
  position: Position
  /**
   * Called on a successful sell, with the message to show. The ticket closes
   * itself at that point, so it CANNOT own that message: setting it locally
   * and then unmounting means the user watches the ticket vanish and sees no
   * confirmation at all — indistinguishable from nothing having happened.
   * The panel outlives the ticket, so the panel says so.
   */
  onDone: (message: string) => void
  onCancel: () => void
}

/**
 * Close (or part-close) one position.
 *
 * A sell is denominated in SHARES, not USD — you sell what you hold — which is
 * the main way this differs from the buy ticket. Tick size and neg-risk are
 * deliberately not sent: positions come from the data API with no Gamma
 * record attached, so the CLOB SDK resolves the real values itself rather than
 * us guessing and getting rejected for an invalid tick.
 */
export const SellTicket: React.FC<SellTicketProps> = ({ position, onDone, onCancel }) => {
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [sharesInput, setSharesInput] = useState(String(floorShares(position.size)))
  const [priceInput, setPriceInput] = useState('')
  const [book, setBook] = useState<{ bestBid: number | null; error?: string }>({ bestBid: null })
  const [submitting, setSubmitting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const snap = await orderbookSnapshotViaOffscreen(position.tokenId)
      if (cancelled) return
      setBook({ bestBid: snap.bestBid, error: snap.error })
      if (snap.bestBid != null) setPriceInput(String(snap.bestBid))
    })()
    return () => { cancelled = true }
  }, [position.tokenId])

  const shares = parseFloat(sharesInput)
  const limitPrice = parseFloat(priceInput)
  // A market sell can't fill BELOW this floor — the mirror of a buy's cap.
  const floorPrice =
    book.bestBid != null
      ? Math.max(0.001, Math.round(book.bestBid * (1 - FLOOR_PCT) * 1000) / 1000)
      : null
  const activePrice = orderType === 'MARKET' ? floorPrice : Number.isFinite(limitPrice) ? limitPrice : null

  const minShares = minOrderShares(undefined)
  const heldShares = floorShares(position.size)
  const proceeds = activePrice != null && shares > 0 ? shares * activePrice : 0

  const tooFew = Number.isFinite(shares) && shares > 0 && shares < minShares
  const tooMany = Number.isFinite(shares) && shares > heldShares
  const positionUnsellable = heldShares < minShares
  const noBid = orderType === 'MARKET' && floorPrice == null
  const priceInvalid =
    orderType === 'LIMIT' && !(Number.isFinite(limitPrice) && limitPrice > 0 && limitPrice < 1)

  const disabled =
    submitting ||
    !(shares > 0) ||
    tooFew ||
    tooMany ||
    positionUnsellable ||
    noBid ||
    priceInvalid ||
    activePrice == null

  async function submit() {
    if (submitting || activePrice == null) return
    setSubmitting(true)
    setResult(null)
    try {
      const r = await sellOrderViaOffscreen({
        tokenId: position.tokenId,
        sizeShares: shares,
        price: activePrice,
        negRisk: false, // ignored — see the module comment; the SDK resolves it
        orderType,
      })
      if (r.ok) {
        onDone(
          `Sell placed${r.orderId ? ` · ${r.orderId.slice(0, 10)}…` : ''}` +
            (orderType === 'LIMIT'
              ? ' — resting on the book until it fills.'
              : ' — positions can take a few seconds to catch up.'),
        )
      } else {
        setResult(`Failed: ${humanSellError(r.error ?? 'unknown_error', minShares)}`)
      }
    } catch (err) {
      setResult(`Error: ${String(err)}`)
    } finally {
      setSubmitting(false)
      setConfirming(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <GlassButton size="sm" full selected={orderType === 'MARKET'} onClick={() => setOrderType('MARKET')} style={pill(orderType === 'MARKET')}>
          Market
        </GlassButton>
        <GlassButton size="sm" full selected={orderType === 'LIMIT'} onClick={() => setOrderType('LIMIT')} style={pill(orderType === 'LIMIT')}>
          Limit
        </GlassButton>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span className="label">Shares to sell (hold {heldShares})</span>
        <input
          type="number"
          min={0}
          max={heldShares}
          step={0.01}
          value={sharesInput}
          onChange={(e) => setSharesInput(e.target.value)}
          className="thin-glass"
        />
      </label>

      {orderType === 'LIMIT' ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="label">Limit price (per share, 0–1)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.001}
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            className="thin-glass"
          />
        </label>
      ) : (
        <Etched size={11} weight={300} color="rgba(35,45,70,.7)">
          Market — sells now, floored at {fmtC(floorPrice)} ({Math.round(FLOOR_PCT * 100)}% max slippage). Bid {fmtC(book.bestBid)}.
        </Etched>
      )}

      <Etched size={11.5} weight={400} color="rgba(35,45,70,.8)">
        Estimated proceeds: {proceeds > 0 ? `$${proceeds.toFixed(2)}` : '—'}
      </Etched>

      {positionUnsellable && (
        <Etched size={11} weight={300} color="rgba(160,40,40,.9)">
          This position is {heldShares} shares — under Polymarket's {minShares}-share minimum, so it can't be sold.
          It can only be redeemed once the market resolves.
        </Etched>
      )}
      {!positionUnsellable && tooFew && (
        <Etched size={11} weight={300} color="rgba(160,40,40,.9)">
          Minimum sell is {minShares} shares.
        </Etched>
      )}
      {tooMany && (
        <Etched size={11} weight={300} color="rgba(160,40,40,.9)">
          You only hold {heldShares} shares.
        </Etched>
      )}
      {noBid && (
        <Etched size={11} weight={300} color="rgba(160,40,40,.9)">
          No bids on the book right now — nobody to sell to. Try a limit order.
        </Etched>
      )}

      {!confirming ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <GlassButton size="sm" full onClick={onCancel}>Close</GlassButton>
          <GlassButton size="sm" full disabled={disabled} onClick={() => { setResult(null); setConfirming(true) }}>
            {`Sell ${orderType === 'MARKET' ? 'now' : 'at limit'}`}
          </GlassButton>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Etched size={11.5} weight={400}>
            Sell {shares} shares at {fmtC(activePrice)} — about ${proceeds.toFixed(2)}?
          </Etched>
          <div style={{ display: 'flex', gap: 6 }}>
            <GlassButton size="sm" full disabled={submitting} onClick={() => setConfirming(false)}>
              Back
            </GlassButton>
            <GlassButton size="sm" full disabled={disabled} onClick={submit}>
              {submitting ? 'Submitting…' : 'Sign in wallet'}
            </GlassButton>
          </div>
        </div>
      )}

      {result && (
        <Etched size={11} weight={300} color={result.startsWith('Sell placed') ? 'rgba(30,110,60,.9)' : 'rgba(160,40,40,.9)'}>
          {result}
        </Etched>
      )}
    </div>
  )
}

/** Shares, truncated to 2dp — the CLOB rejects more precision than it quotes,
 * and "sell everything" must never round UP past what is actually held. */
function floorShares(size: number): number {
  return Math.floor(size * 100) / 100
}

const fmtC = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}¢`)

function pill(active: boolean): React.CSSProperties {
  return active
    ? { background: 'rgba(64,120,215,.34)', borderColor: 'rgba(64,120,215,.9)', color: 'rgba(12,30,70,.98)', fontWeight: 500 }
    : { background: 'rgba(255,255,255,.05)', borderColor: 'rgba(35,45,70,.18)', color: 'rgba(35,45,70,.55)' }
}

export function humanSellError(raw: string, minShares: number): string {
  if (/min[_ ]size|minimum (order )?size/i.test(raw)) {
    return `Below Polymarket's ${minShares}-share minimum.`
  }
  if (/not enough balance|insufficient|allowance/i.test(raw)) {
    return "Polymarket says you don't hold enough of this token — refresh your positions."
  }
  if (/not filled|fok/i.test(raw)) {
    return "Couldn't fill the whole sell at your floor price — the book moved. Try a limit order."
  }
  if (/tick size|invalid price/i.test(raw)) {
    return "That price isn't a valid tick for this market."
  }
  if (/no_wallet/i.test(raw)) return 'Wallet session expired — reconnect and try again.'
  return raw
}
