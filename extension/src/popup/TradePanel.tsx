import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MatchResult } from '../shared/types'
import { restoreWallet, type WalletState } from '../background/trade'
import { type GeoErrorReason, getGeoStatus } from '../background/geo'
import { getSettings } from '../background/settings'
import { ConnectButton } from './trade/ConnectButton'
import { OrderForm } from './trade/OrderForm'
import { Sparkline } from './trade/Sparkline'
import { Orderbook } from './trade/Orderbook'
import { PayoutPreview as _PayoutPreview } from './trade/PayoutPreview' // re-exported via OrderForm; keep import alive in case of tree-shake edge case
import { ResolutionCard } from './trade/ResolutionCard'
import { GeoBlock } from './trade/GeoBlock'

void _PayoutPreview // explicitly retain — never invoked here

interface Props {
  /** Current matched market from CheckPage, or null if user hasn't checked yet. */
  match: MatchResult | null
}

/**
 * Trade tab. Three states by precedence:
 *   1. geo-blocked → only GeoBlock, no wallet UI at all
 *   2. wallet not connected → ConnectButton + light market preview
 *   3. wallet connected + match present → full Trade view (analytics + form)
 *
 * If `match` is null (user opened Trade tab before checking a page), we
 * show a gentle empty state directing them to the Check tab.
 */
export function TradePanel({ match }: Props) {
  const { t } = useTranslation()
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [geo, setGeo] = useState<{
    blocked: boolean
    country: string
    unknown: boolean
    errorReason?: GeoErrorReason
  } | null>(null)
  const [loaded, setLoaded] = useState(false)

  // On mount: restore wallet session (if any), then check geo.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const w = await restoreWallet()
        if (!cancelled) setWallet(w)
      } catch {
        // ignore — treated as disconnected
      }
      try {
        const s = await getSettings()
        if (s.workerUrl && s.workerSecret) {
          const g = await getGeoStatus(s.workerUrl, s.workerSecret)
          if (!cancelled) setGeo({
            blocked: g.blocked,
            country: g.country,
            unknown: g.unknown,
            errorReason: g.errorReason,
          })
        }
      } catch {
        // ignore — geo block treats unknown as blocked at submit time
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!loaded) return <p className="intro">…</p>

  // Only hard-block on a *confirmed* restricted country. If the geo lookup
  // failed we render the full Trade UI but show a warning at the top — the
  // user can still browse market analytics; if they actually are in a
  // restricted region, Polymarket will reject their order at submit time.
  if (geo?.blocked && !geo.unknown) {
    return <GeoBlock country={geo.country} />
  }

  if (!match) {
    return (
      <p className="intro">
        Open a news article and run <b>Check</b> first. The matched market
        will appear here for one-click trading.
      </p>
    )
  }

  // Outcome 0 = YES; its current implied probability is the first outcomePrice.
  const yesPrice = parseFirstPrice(match.market.outcomePrices)
  // Fresh price (from CLOB) overrides if available.
  const livePrice = match.freshPrice ?? yesPrice
  const tokenIdYes = match.market.clobTokenIds[0]

  return (
    <div>
      {geo?.unknown && <GeoLookupHint reason={geo.errorReason} />}
      <div className="match-card" data-mood={match.color} style={{ marginTop: 0 }}>
        <div className="match-meta">{t('trade.title')}</div>
        <p className="match-question">{match.market.question}</p>
        {tokenIdYes && <Sparkline tokenId={tokenIdYes} color={match.color} />}
        <div style={{ marginTop: 8 }}>
          {tokenIdYes && <Orderbook tokenId={tokenIdYes} />}
        </div>
        <ResolutionCard market={match.market} />
      </div>

      <ConnectButton state={wallet} onChange={setWallet} />

      {wallet ? (
        <OrderForm market={match.market} state={wallet} price={livePrice} />
      ) : (
        <div className="hint" style={{ marginTop: 6 }}>
          Connect a wallet to place a builder-attributed order in one signature.
        </div>
      )}
    </div>
  )
}

function parseFirstPrice(raw: string): number {
  try {
    const arr = JSON.parse(raw) as string[]
    return Number(arr[0] ?? '0')
  } catch {
    return 0
  }
}

/**
 * Inline notice when the geo check failed for an actionable reason. Doesn't
 * gate the Trade UI — Polymarket itself rejects orders from restricted
 * regions, so the worst case is the user sees the analytics and gets a clear
 * error at order submission instead of silently being locked out here.
 */
function GeoLookupHint({ reason }: { reason?: GeoErrorReason }) {
  const msg = reasonMessage(reason)
  return (
    <div className="warning" style={{ marginTop: 0, marginBottom: 10 }}>
      {msg}
    </div>
  )
}

function reasonMessage(r?: GeoErrorReason): string {
  switch (r) {
    case 'no_worker':
      return "Add your Worker URL and secret in Settings to enable trading."
    case 'unauthorized':
      return "Worker rejected this extension (origin or secret mismatch). " +
        "Add this extension's ID to ALLOWED_EXTENSION_ID on Cloudflare " +
        "(comma-separated list supported)."
    case 'misconfigured':
      return "Your Worker is missing required env vars (WORKER_SHARED_SECRET or ALLOWED_EXTENSION_ID)."
    case 'rate_limited':
      return "Hit Worker rate limit. Try again in a minute."
    case 'network':
      return "Couldn't reach the Worker. Check your network and the Worker URL in Settings."
    default:
      return "Couldn't verify your region. Trading will work if you're not in a restricted area; Polymarket itself will reject restricted regions at order time."
  }
}
