import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  defaultThresholds,
  fetchLivePrice,
  fetchMarketById,
  fetchOrderbookJson,
  LOCAL_MODEL_ID,
  resolveOrderToken,
} from '@actually/core'
import { DAILY_LIMIT_USD, MAX_ORDER_USD, PKG_VERSION, PRIVATE_KEY, REDEEM_ENABLED, SPEND_GUARD_STATE_PATH, requireWorkerConfig } from './config'
import { WorkerMarketStore } from './marketStore'
import { LocalEmbedder } from './embedder'
import { SpendGuard } from './spendGuard'
import { checkTradingGeoGate } from './geoGate'
import { resolveMarket } from './resolveMarket'
import { fetchPositions } from './positions'
import { checkNews } from './tools/checkNews'
import { getMarket } from './tools/getMarket'
import { placeOrder } from './tools/placeOrder'
import { sellOrder } from './tools/sellOrder'
import { cancelOrder } from './tools/cancelOrder'
import { getOpenOrders } from './tools/getOpenOrders'
import { getPositions } from './tools/getPositions'
import { redeemPosition } from './tools/redeemPosition'
import { makeTradingSession } from './tradingSession'
import { makeRelayerSubmit } from './relayerClient'

const server = new McpServer({ name: 'actually-mcp-server', version: PKG_VERSION })

const embedder = new LocalEmbedder()
const thresholds = defaultThresholds('local')

// Lazy singleton: requireWorkerConfig() still only throws on first actual
// tool use (so the server starts and lists tools fine even with missing
// worker config), but the SAME WorkerMarketStore instance is reused across
// all tool calls so its 5-minute in-memory cache and in-flight-fetch dedupe
// actually do their job across a session instead of being rebuilt (and thus
// defeated) on every single call.
let store: WorkerMarketStore | null = null
function getStore(): WorkerMarketStore {
  if (!store) {
    const { workerUrl, workerSecret } = requireWorkerConfig()
    store = new WorkerMarketStore(workerUrl, workerSecret, LOCAL_MODEL_ID)
  }
  return store
}

function resolveMarketOrThrow(marketId: string) {
  const { workerUrl, workerSecret } = requireWorkerConfig()
  return resolveMarket(
    { store: getStore(), fetchMarketById: (id) => fetchMarketById(id, workerUrl, workerSecret) },
    marketId,
  )
}

server.registerTool(
  'check_news',
  {
    description:
      'Map a piece of news text to the relevant Polymarket market and return its ' +
      'objective YES probability. Does not classify whether the news is dramatized ' +
      'or accurate relative to the market — that interpretation is left to the ' +
      'calling agent, which has both the original text and this market anchor. ' +
      'The probability comes from a precomputed cache refreshed on a cron cadence ' +
      '(can be up to ~2 hours stale) — for a live price before trading, call ' +
      'get_market with the returned marketId.',
    inputSchema: { text: z.string().min(1).max(8000) },
  },
  async ({ text }) => {
    const result = await checkNews({ store: getStore(), embedder, thresholds }, { text })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
)

server.registerTool(
  'get_market',
  {
    description:
      'Look up a specific Polymarket market by id: details, live price, and an ' +
      'orderbook snapshot. Falls back to a direct Gamma lookup when the id is ' +
      "outside the precomputed cache's top markets by volume.",
    inputSchema: { marketId: z.string().min(1) },
  },
  async ({ marketId }) => {
    const { workerUrl, workerSecret } = requireWorkerConfig()
    const result = await getMarket(
      {
        store: getStore(),
        fetchLivePrice: (tokenId) => fetchLivePrice(tokenId, workerUrl, workerSecret),
        fetchOrderbook: (tokenId) => fetchOrderbookJson(tokenId, workerUrl, workerSecret),
        fetchMarketById: (id) => fetchMarketById(id, workerUrl, workerSecret),
      },
      { marketId },
    )
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
)

// Trading tools (place_order, sell_order, cancel_order, get_open_orders,
// get_positions) are only registered when an operator has configured their
// own signing key — no key custody happens on our side, ever (see design
// spec). They share one TradingSession so credential derivation happens once
// per process, and one SpendGuard so a per-order and daily USD ceiling is
// enforced across both buys and sells.
if (PRIVATE_KEY) {
  const session = makeTradingSession(PRIVATE_KEY)
  const spendGuard = new SpendGuard({
    maxOrderUsd: MAX_ORDER_USD,
    dailyLimitUsd: DAILY_LIMIT_USD,
    statePath: SPEND_GUARD_STATE_PATH,
  })

  server.registerTool(
    'place_order',
    {
      description:
        "Buy YES or NO shares in a Polymarket market using this server's configured " +
        "POLYMARKET_PRIVATE_KEY, with this server's builder code attached. The token " +
        "to trade is resolved server-side from marketId + side — callers cannot " +
        `supply a raw token id. Capped at $${MAX_ORDER_USD}/order and $${DAILY_LIMIT_USD}/day.`,
      inputSchema: {
        marketId: z.string().min(1),
        side: z.enum(['BUY_YES', 'BUY_NO']),
        sizeUsd: z.number().positive(),
        price: z.number().gt(0).lt(1),
        orderType: z.enum(['LIMIT', 'MARKET']),
      },
    },
    async (input) => {
      const { workerUrl, workerSecret } = requireWorkerConfig()
      const geo = await checkTradingGeoGate(workerUrl, workerSecret)
      if (geo.blocked) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'geo_blocked' }) }] }
      }
      const market = await resolveMarketOrThrow(input.marketId)
      if (!market) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'market_not_found' }) }] }
      }
      const target = resolveOrderToken(market, input.side === 'BUY_YES' ? 'Yes' : 'No')
      const result = await placeOrder(
        { privateKey: PRIVATE_KEY, signAndSubmit: session.signAndSubmitBuy, spendGuard },
        { marketId: input.marketId, side: input.side, sizeUsd: input.sizeUsd, price: input.price, orderType: input.orderType, ...target },
      )
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'sell_order',
    {
      description:
        'Sell YES or NO shares you hold in a Polymarket market (close or reduce a ' +
        'position), signed with this server\'s configured POLYMARKET_PRIVATE_KEY. ' +
        `Capped at an estimated $${MAX_ORDER_USD}/order and $${DAILY_LIMIT_USD}/day ` +
        '(shares × price), shared with place_order\'s budget.',
      inputSchema: {
        marketId: z.string().min(1),
        side: z.enum(['SELL_YES', 'SELL_NO']),
        sizeShares: z.number().positive(),
        price: z.number().gt(0).lt(1),
        orderType: z.enum(['LIMIT', 'MARKET']),
      },
    },
    async (input) => {
      const { workerUrl, workerSecret } = requireWorkerConfig()
      const geo = await checkTradingGeoGate(workerUrl, workerSecret)
      if (geo.blocked) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'geo_blocked' }) }] }
      }
      const market = await resolveMarketOrThrow(input.marketId)
      if (!market) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'market_not_found' }) }] }
      }
      const target = resolveOrderToken(market, input.side === 'SELL_YES' ? 'Yes' : 'No')
      const result = await sellOrder(
        { privateKey: PRIVATE_KEY, signAndSubmit: session.signAndSubmitSell, spendGuard },
        { marketId: input.marketId, side: input.side, sizeShares: input.sizeShares, price: input.price, orderType: input.orderType, ...target },
      )
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'cancel_order',
    {
      description: "Cancel one of this server's resting orders by order id.",
      inputSchema: { orderId: z.string().min(1) },
    },
    async (input) => {
      const result = await cancelOrder({ privateKey: PRIVATE_KEY, cancelOrder: session.cancelOrder }, input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'get_open_orders',
    {
      description: "List this server's resting orders, optionally filtered to one market.",
      inputSchema: { marketId: z.string().optional() },
    },
    async (input) => {
      const result = await getOpenOrders({ privateKey: PRIVATE_KEY, listOpenOrders: session.listOpenOrders }, input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'get_positions',
    {
      description:
        "List this server's current Polymarket positions with cost basis and unrealized P&L. " +
        'A `redeemable: true` position has resolved and is ready for redeem_position.',
      inputSchema: {},
    },
    async () => {
      const result = await getPositions({
        privateKey: PRIVATE_KEY,
        getFunderAddress: session.getFunderAddress,
        fetchPositions,
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  // redeem_position needs a second, explicit opt-in beyond just having a
  // signing key configured — see REDEEM_ENABLED's doc comment in config.ts.
  // Unset, the tool isn't registered at all (not "registered but errors" —
  // an agent enumerating tools shouldn't even see it as an option).
  if (REDEEM_ENABLED) {
    const relayerSubmit = makeRelayerSubmit(PRIVATE_KEY)
    server.registerTool(
      'redeem_position',
      {
        description:
          'Claim payout for a resolved, winning position (get its conditionId from ' +
          'get_positions — only positions with redeemable:true can be redeemed). This ' +
          'is an on-chain transaction submitted through the Polymarket relayer, not a ' +
          'CLOB order — no POL/gas needed in your wallet, Polymarket covers it. ' +
          'Not gated by the spend guard (this claims money owed to you, it does not risk new capital).',
        inputSchema: { conditionId: z.string().min(1) },
      },
      async (input) => {
        const result = await redeemPosition(
          { privateKey: PRIVATE_KEY, getFunderAddress: session.getFunderAddress, fetchPositions, submit: relayerSubmit },
          input,
        )
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
