import type { OpenOrderSummary } from '../clobClient'

export interface GetOpenOrdersInput {
  marketId?: string
}

export interface GetOpenOrdersDeps {
  privateKey: string | undefined
  listOpenOrders: (marketId?: string) => Promise<OpenOrderSummary[]>
}

export interface GetOpenOrdersOutput {
  ok: boolean
  orders?: OpenOrderSummary[]
  error?: string
}

export async function getOpenOrders(deps: GetOpenOrdersDeps, input: GetOpenOrdersInput): Promise<GetOpenOrdersOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }
  try {
    const orders = await deps.listOpenOrders(input.marketId)
    return { ok: true, orders }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
