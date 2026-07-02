import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { defaultThresholds, fetchLivePrice, fetchOrderbookJson, LOCAL_MODEL_ID } from '@actually/core'
import { BUILDER_CODE, PRIVATE_KEY, requireWorkerConfig } from './config'
import { WorkerMarketStore } from './marketStore'
import { LocalEmbedder } from './embedder'
import { checkNews } from './tools/checkNews'
import { getMarket } from './tools/getMarket'
import { placeOrder } from './tools/placeOrder'
import { prepareOrder } from './tools/prepareOrder'
import { makeSignAndSubmit } from './tools/placeOrderLive'

const server = new McpServer({ name: 'actually-mcp-server', version: '0.1.0' })

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

server.registerTool(
  'check_news',
  {
    description:
      'Map a piece of news text to the relevant Polymarket market and return its ' +
      'objective YES probability. Does not classify whether the news is dramatized ' +
      'or accurate relative to the market — that interpretation is left to the ' +
      'calling agent, which has both the original text and this market anchor.',
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
    description: 'Look up a specific Polymarket market by id: details, live price, and an orderbook snapshot.',
    inputSchema: { marketId: z.string().min(1) },
  },
  async ({ marketId }) => {
    const { workerUrl, workerSecret } = requireWorkerConfig()
    const result = await getMarket(
      {
        store: getStore(),
        fetchLivePrice: (tokenId) => fetchLivePrice(tokenId, workerUrl, workerSecret),
        fetchOrderbook: (tokenId) => fetchOrderbookJson(tokenId, workerUrl, workerSecret),
      },
      { marketId },
    )
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
)

server.registerTool(
  'prepare_order',
  {
    description:
      "Build an UNSIGNED Polymarket order carrying this server's builder code, for " +
      'callers who sign with their own wallet tooling. The builder code is only ' +
      'preserved if the returned object is signed exactly as-is.',
    inputSchema: {
      tokenId: z.string().min(1),
      side: z.enum(['BUY_YES', 'BUY_NO']),
      sizeUsd: z.number().positive(),
      price: z.number().min(0).max(1),
      orderType: z.enum(['LIMIT', 'MARKET']),
      negRisk: z.boolean(),
      tickSize: z.string().optional(),
    },
  },
  async (input) => {
    const result = prepareOrder({ builderCode: BUILDER_CODE }, input)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
)

// place_order is only registered when an operator has configured their own
// signing key — no key custody happens on our side, ever (see design spec).
if (PRIVATE_KEY) {
  const signAndSubmit = makeSignAndSubmit(PRIVATE_KEY)
  server.registerTool(
    'place_order',
    {
      description:
        "Sign and submit a Polymarket order using this server's configured " +
        "POLYMARKET_PRIVATE_KEY, with this server's builder code attached.",
      inputSchema: {
        marketId: z.string().min(1),
        tokenId: z.string().min(1),
        side: z.enum(['BUY_YES', 'BUY_NO']),
        sizeUsd: z.number().positive(),
        price: z.number().min(0).max(1),
        orderType: z.enum(['LIMIT', 'MARKET']),
        negRisk: z.boolean(),
        tickSize: z.string().optional(),
      },
    },
    async (input) => {
      const result = await placeOrder({ privateKey: PRIVATE_KEY, signAndSubmit }, input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
