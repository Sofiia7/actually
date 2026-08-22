import {
  findOutcomeIndex,
  floorSlippage,
  marketFloorPrice,
  parseOrderbook,
  priceFromOutcomes,
  type MarketStore,
  type PolyMarket,
  type RawOrderbook,
} from '@actually/core'

export interface GetMarketInput {
  marketId: string
}

export interface GetMarketOutput {
  found: boolean
  market?: {
    marketId: string
    slug: string
    question: string
    endDate?: string
    clobTokenIds: string[]
    negRisk: boolean
    tickSize?: string
    probabilityYes: number
  }
  livePrice?: number | null
  orderbook?: {
    bestBid: number | null
    bestAsk: number | null
    spread: number | null
    /**
     * Price to pass as `price` for a MARKET sell, and the slippage it accepts.
     *
     * Handed over rather than left to the caller because getting it wrong is
     * silent and total: a market sell is fill-or-kill, so a floor equal to
     * the bid only fills if the entire size happens to rest on that one
     * price level. On a 1.1¢ book a nominal 2% band is thinner than half a
     * tick and rounds straight back onto the bid, which made every market
     * sell under 2.5¢ structurally impossible in the extension until this
     * math was fixed. An agent picking "the bid" would land in exactly that
     * hole with nothing to warn it.
     */
    marketSellFloor?: { price: number; maxSlippage: number } | null
  }
}

/**
 * Slippage band a market sell asks for. Matches the extension's ticket so
 * both clients quote the same number; the tick can force a wider real one,
 * which is why `maxSlippage` is reported alongside rather than assumed.
 */
const MARKET_SELL_FLOOR_PCT = 0.02

export interface GetMarketDeps {
  store: MarketStore
  fetchLivePrice: (tokenId: string) => Promise<number | null>
  fetchOrderbook: (tokenId: string) => Promise<RawOrderbook>
  /**
   * Fallback lookup against Gamma directly when `marketId` isn't in the
   * precomputed cache — the cache only holds the top MAX_MARKETS_CACHE
   * markets by volume, so a valid id outside that cut would otherwise
   * always report found:false. Optional so cache-only callers/tests are
   * unaffected.
   */
  fetchMarketById?: (marketId: string) => Promise<PolyMarket | null>
}

// Errors from deps.store/deps.fetchLivePrice/deps.fetchOrderbook (network
// failures, worker errors, etc.) propagate uncaught — the MCP tool-registration
// layer is responsible for catching and converting to a tool-error response.
export async function getMarket(deps: GetMarketDeps, input: GetMarketInput): Promise<GetMarketOutput> {
  const markets = await deps.store.getMarkets()
  let market: PolyMarket | undefined = markets.find((m) => m.id === input.marketId)
  if (!market && deps.fetchMarketById) {
    market = (await deps.fetchMarketById(input.marketId)) ?? undefined
  }
  if (!market) {
    return { found: false }
  }

  const yesIdx = findOutcomeIndex(market.outcomes, 'Yes')
  const yesTokenId = market.clobTokenIds[yesIdx]
  const probabilityYes = priceFromOutcomes(market.outcomePrices, market.outcomes)

  const [livePrice, book] = await Promise.all([
    yesTokenId ? deps.fetchLivePrice(yesTokenId) : Promise.resolve(null),
    yesTokenId ? deps.fetchOrderbook(yesTokenId) : Promise.resolve({ asks: [], bids: [] }),
  ])
  const snap = parseOrderbook(book)

  return {
    found: true,
    market: {
      marketId: market.id,
      slug: market.slug,
      question: market.question,
      endDate: market.endDate,
      clobTokenIds: market.clobTokenIds,
      negRisk: market.negRisk ?? false,
      tickSize: market.tickSize,
      probabilityYes,
    },
    livePrice,
    orderbook: {
      bestBid: snap.bestBid,
      bestAsk: snap.bestAsk,
      spread: snap.spread,
      marketSellFloor:
        snap.bestBid != null
          ? (() => {
              const price = marketFloorPrice(snap.bestBid, MARKET_SELL_FLOOR_PCT, market.tickSize ?? '0.001')
              return { price, maxSlippage: floorSlippage(snap.bestBid, price) }
            })()
          : null,
    },
  }
}
