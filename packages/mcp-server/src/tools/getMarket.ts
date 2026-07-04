import {
  findOutcomeIndex,
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
  orderbook?: { bestBid: number | null; bestAsk: number | null; spread: number | null }
}

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
    orderbook: { bestBid: snap.bestBid, bestAsk: snap.bestAsk, spread: snap.spread },
  }
}
