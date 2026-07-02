export interface RawOrderbookLevel {
  price: string
  size: string
}

export interface RawOrderbook {
  asks?: RawOrderbookLevel[]
  bids?: RawOrderbookLevel[]
}

export interface OrderbookSnapshot {
  bestBid: number | null
  bestAsk: number | null
  spread: number | null
  /** Estimated effective price for a market buy of `sizeShares`. */
  estimateBuy: (sizeShares: number) => { effectivePrice: number; slippage: number } | null
}

/** Pure book-level math — no fetch, no signer. Shared by the extension's
 * wallet-bound orderbook path and the MCP server's unauthenticated one. */
export function parseOrderbook(book: RawOrderbook): OrderbookSnapshot {
  // A malformed level (non-numeric price/size from a flaky upstream response)
  // would otherwise poison sort/spread/estimateBuy with NaN — which
  // JSON.stringify silently renders as `null`, indistinguishable from "no
  // orderbook data" to a caller. Drop the level instead of propagating NaN.
  const asks = (book.asks ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
  const bids = (book.bids ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
  asks.sort((a, b) => a.price - b.price)
  bids.sort((a, b) => b.price - a.price)

  const bestAsk = asks[0]?.price ?? null
  const bestBid = bids[0]?.price ?? null
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null

  return {
    bestBid,
    bestAsk,
    spread,
    estimateBuy: (sizeShares) => {
      if (asks.length === 0 || bestAsk == null) return null
      let remaining = sizeShares
      let cost = 0
      for (const lvl of asks) {
        const take = Math.min(remaining, lvl.size)
        cost += take * lvl.price
        remaining -= take
        if (remaining <= 0) break
      }
      if (remaining > 0) {
        const worstAsk = asks[asks.length - 1]?.price ?? bestAsk
        return { effectivePrice: worstAsk, slippage: 1 }
      }
      const eff = cost / sizeShares
      const slip = (eff - bestAsk) / bestAsk
      return { effectivePrice: eff, slippage: slip }
    },
  }
}
