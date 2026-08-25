import { describeError } from '../../shared/describeError'
import React, { useEffect, useRef, useState } from 'react'
import { IceCard } from './IceCard'
import { Etched } from './Etched'
import { LinkAction } from './LinkAction'
import { SellTicket } from '../SellTicket'
import { builderStatusViaOffscreen, redeemPositionViaOffscreen } from '../ops'
import { logTrade } from '../../background/tradeLog'
import { buildMarketUrl } from '../../background/polymarket'
import type { OpenOrderSummary, Position } from '../../shared/types'

/** Redeem failures the user can actually do something about. */
export function humanRedeemError(raw: string): string {
  if (/not_yet_redeemable/.test(raw)) {
    return "Polymarket doesn't consider this resolved yet - try again once it settles."
  }
  if (/position_not_found/.test(raw)) return 'That position is no longer held - refresh.'
  if (/no_wallet/.test(raw)) return 'Wallet session expired - reconnect and try again.'
  if (/worker_not_configured/.test(raw)) return 'Set the Worker URL and secret in Settings first.'
  if (/wc_provider_unsupported_method|personal_sign/i.test(raw)) {
    return "Your wallet didn't grant permission to sign this. Reconnect and approve the full request."
  }
  if (/redeem_status_unknown/.test(raw)) {
    return "The redeem was submitted but its final status couldn't be confirmed - wait a minute and refresh your positions before retrying."
  }
  // The relayer rejects unauthenticated /submit outright.
  //
  // The old copy here named a cause it could not possibly know ("in-app
  // redeem needs a builder API key this build doesn't have yet") and it was
  // wrong for weeks: the key existed and signed fine, while a missing CORS
  // header stopped the browser from ever fetching a signature (see CORS_BASE
  // in worker/index.ts). Users were told the deployment lacked a credential
  // it had, and steered away from a feature that was one header from working.
  //
  // This now reports only what a 401 actually proves - the request reached
  // Polymarket without valid authorization - and offers the route that always
  // works, instead of guessing at why.
  if (/invalid authorization|clob_http_401|"status":401|\b401\b/.test(raw)) {
    return "Polymarket refused the request as unauthorized (401), so the redeem didn't go through. Claim the payout on Polymarket instead; the position and funds are safe."
  }
  // The relayer's own precheck, and the one case where a redeem failing is
  // the correct outcome: the market resolved against this position, so the
  // tokens settle to nothing. Shown as raw JSON before this branch existed.
  if (/PRECHECK_SKIPPED|zero position balance/i.test(raw)) {
    return "Nothing to claim here - this outcome didn't win, so the position settles to $0. Your other positions are unaffected."
  }
  if (/relayer_state/.test(raw)) {
    return 'The transaction failed on-chain. Nothing was redeemed - try again shortly.'
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
  /** Set when the last positions/open-orders fetch failed - shown instead of silently rendering an empty list. */
  portfolioError?: string | null
  /** Set when the last cancel attempt failed - cleared on the next successful cancel or refresh. */
  cancelError?: string | null
}

/**
 * Cost basis is printed next to the entry price on purpose.
 *
 * Every number on the row comes straight from Polymarket's data-api, and that
 * API can briefly disagree with itself after a fill: a $2 buy of 153.84 shares
 * showed up as "@ 6.0¢ … -$7.38 (-80.0%)" for a minute before settling to
 * "@ 1.3¢ … -$0.15 (-7.7%)". Both readings were internally consistent, so
 * nothing on screen gave it away - a user who paid $2 had to reverse-engineer
 * an $9.23 cost basis out of a percentage to see that the row was wrong.
 * Spelling out size × avgPrice makes that visible at a glance instead.
 */
const fmtUsd = (v: number) => `$${v.toFixed(2)}`

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
const shortenMarketId = (id: string) => (id.length > 10 ? `${id.slice(0, 10)}…` : id)

/**
 * Whether a resolved position has anything to collect.
 *
 * `redeemable` from data-api means "this market has resolved", NOT "there is
 * money here" - it comes back true for every holder of the losing side, with
 * curPrice 0.0000 and currentValue 0.00 alongside it. Reading it as the
 * latter is what put a "Redeem →" link on a position worth exactly nothing:
 * the click cost a wallet signature and then failed, every time, with the
 * relayer's own PRECHECK_SKIPPED: zero position balance.
 */
function hasPayout(p: Position): boolean {
  return p.currentValue > 0 || p.curPrice > 0
}


/**
 * Read-only view of the connected wallet's current Polymarket positions and
 * resting orders - previously the only way to see either was polymarket.com
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
  // Which position's sell ticket is open. One at a time, by tokenId - an
  // expanded ticket per row would let two sells be half-filled in at once.
  const [sellingTokenId, setSellingTokenId] = useState<string | null>(null)
  // Confirmation for a sell that has already closed its ticket. Held here
  // because the panel outlives the ticket - see SellTicket's onDone. Redeem
  // outcomes land here too, so the notice carries its own tone: a failure
  // painted in the success green reads as a confirmation to anyone skimming.
  const [sellNotice, setSellNotice] = useState<{ text: string; isError: boolean; slug?: string } | null>(null)
  const lagRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (lagRefreshRef.current) clearTimeout(lagRefreshRef.current)
    },
    [],
  )

  const [redeemingId, setRedeemingId] = useState<string | null>(null)
  // Whether the deployment can redeem in-app at all (Worker holds builder API
  // credentials). Asked at runtime rather than baked into the build, so the
  // button appears the moment those credentials are configured - and never
  // before, since without them the relayer 401s AFTER the wallet has signed.
  const [canRedeemInApp, setCanRedeemInApp] = useState(false)
  const hasRedeemable = positions.some((p) => p.redeemable)
  useEffect(() => {
    if (!hasRedeemable) return
    let cancelled = false
    void builderStatusViaOffscreen().then((ok) => {
      if (!cancelled) setCanRedeemInApp(ok)
    })
    return () => {
      cancelled = true
    }
  }, [hasRedeemable])

  async function onRedeem(conditionId: string) {
    // A LinkAction is a plain <a> with no native disabled state, and this one
    // signs an on-chain call - guard synchronously so a double-click can't
    // submit two relayer transactions for the same position.
    if (redeemingId) return
    setRedeemingId(conditionId)
    setSellNotice(null)
    try {
      const r = await redeemPositionViaOffscreen(conditionId)
      const held = positions.find((p) => p.conditionId === conditionId)
      void logTrade({
        kind: 'REDEEM',
        status: r.ok ? 'placed' : /redeem_status_unknown/.test(r.error ?? '') ? 'unknown' : 'failed',
        question: held?.title ?? 'Resolved market',
        marketSlug: held?.slug,
        outcome: held?.outcome,
        shares: held?.size,
        ref: r.transactionId,
        error: r.ok ? undefined : humanRedeemError(r.error ?? 'unknown_error'),
      })
      setSellNotice(
        r.ok
          ? { text: `Redeemed${r.transactionId ? ` · ${r.transactionId.slice(0, 10)}…` : ''} - the payout lands in your Polymarket balance. Saved to History.`, isError: false }
          : { text: humanRedeemError(r.error ?? 'unknown_error'), isError: true, slug: held?.slug },
      )
    } catch (err) {
      setSellNotice({
        text: describeError(err),
        isError: true,
        slug: positions.find((p) => p.conditionId === conditionId)?.slug,
      })
      void logTrade({
        kind: 'REDEEM',
        status: 'failed',
        question: positions.find((p) => p.conditionId === conditionId)?.title ?? 'Resolved market',
        error: describeError(err),
      })
    } finally {
      setRedeemingId(null)
      onRefresh()
      if (lagRefreshRef.current) clearTimeout(lagRefreshRef.current)
      lagRefreshRef.current = setTimeout(onRefresh, 5000)
    }
  }

  function onSold(message: string) {
    setSellNotice({ text: message, isError: false })
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
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 9,
            background: sellNotice.isError ? 'rgba(160,40,40,.09)' : 'rgba(30,110,60,.10)',
            border: `1px solid ${sellNotice.isError ? 'rgba(160,40,40,.4)' : 'rgba(30,110,60,.42)'}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <Etched size={13} weight={500} color={sellNotice.isError ? 'rgba(150,32,32,.98)' : 'rgba(22,95,52,.98)'}>
            {sellNotice.isError ? '✕ Didn’t go through' : '✓ Done'}
          </Etched>
          <Etched size={12} weight={300} style={{ lineHeight: 1.45 }}>
            {sellNotice.text}
          </Etched>
          <div style={{ display: 'flex', gap: 10 }}>
            <LinkAction onClick={() => setSellNotice(null)}>Dismiss</LinkAction>
            {sellNotice.isError && sellNotice.slug && (
              <LinkAction
                onClick={() =>
                  window.open(buildMarketUrl(sellNotice.slug!), '_blank', 'noopener,noreferrer')
                }
              >
                Open on Polymarket →
              </LinkAction>
            )}
          </div>
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
              {p.size.toFixed(2)} shares @ {(p.avgPrice * 100).toFixed(1)}¢ ({fmtUsd(p.size * p.avgPrice)}) · now{' '}
              {fmtUsd(p.currentValue)}
            </Etched>
            <Etched size={11} weight={400} color={p.cashPnl >= 0 ? 'rgba(30,110,60,.9)' : 'rgba(160,40,40,.9)'}>
              {fmtUsd(p.cashPnl)} ({fmtPct(p.percentPnl)})
            </Etched>
          </div>

          {/* A resolved market no longer trades - offering Sell there would
              only ever produce a CLOB rejection. Those are redeemed instead. */}
          {p.redeemable ? (
            !hasPayout(p) ? (
              /* Resolved AGAINST this position: the tokens still sit in the
                 wallet, and data-api still calls them redeemable, but they
                 settle to nothing. Redeeming used to be offered here anyway
                 and could only ever fail - after a wallet signature - with
                 the relayer's "PRECHECK_SKIPPED: zero position balance",
                 which is the chain agreeing there is nothing to collect. */
              <div style={{ marginTop: 5 }}>
                <Etched size={10.5} weight={300} color="rgba(35,45,70,.5)">
                  Resolved · this outcome didn't win, so there's nothing to claim
                </Etched>
              </div>
            ) : canRedeemInApp ? (
              <div style={{ marginTop: 5, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <LinkAction onClick={() => void onRedeem(p.conditionId)}>
                  {redeemingId === p.conditionId ? 'Redeeming…' : 'Redeem →'}
                </LinkAction>
                <Etched size={10.5} weight={300} color="rgba(35,45,70,.5)">
                  Market resolved · no gas needed · in testing
                </Etched>
              </div>
            ) : (
              /* No builder API credentials on the Worker → the relayer will
                 401 this, and the SDK asks the wallet to sign BEFORE it
                 posts, so an in-app button would cost a signature per
                 attempt and fail every time. Send the user where the payout
                 actually works today. */
              <div style={{ marginTop: 5, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <LinkAction
                  onClick={() =>
                    window.open(
                      p.slug ? buildMarketUrl(p.slug) : 'https://polymarket.com/portfolio',
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
                >
                  Claim on Polymarket →
                </LinkAction>
                <Etched size={10.5} weight={300} color="rgba(35,45,70,.5)">
                  Resolved · claiming in-app isn't available yet
                </Etched>
              </div>
            )
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
