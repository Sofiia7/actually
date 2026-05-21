import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MatchResult } from '../shared/types'
import { restoreWallet, type WalletState } from '../background/trade'
import { getGeoStatus } from '../background/geo'
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
  const [geo, setGeo] = useState<{ blocked: boolean; country: string; unknown: boolean } | null>(null)
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
          if (!cancelled) setGeo({ blocked: g.blocked, country: g.country, unknown: g.unknown })
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

  // Only block on a *confirmed* restricted country. If the geo lookup failed
  // (Worker misconfigured, network error, etc.) we surface that as a Settings
  // hint instead of silently locking the user out of the Trade tab.
  if (geo?.blocked && !geo.unknown) {
    return <GeoBlock country={geo.country} />
  }
  if (geo?.unknown) {
    return (
      <div className="warning" style={{ marginTop: 0 }}>
        Couldn't verify your region. Check your Worker URL and secret in
        Settings, then reload the popup.
      </div>
    )
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
