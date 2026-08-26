# Installing the Actually MCP server

This file is for an AI assistant setting the server up on a user's behalf
(Cline reads it by convention). A human can follow it too, but the README is
friendlier.

## What this repository contains

A monorepo. Only one part of it is an MCP server:

- `packages/mcp-server/` - the MCP server, published to npm as
  **`actually-mcp-server`**
- `extension/` - a Chrome extension, unrelated to MCP setup
- `packages/core/`, `packages/market-cache-builder/`, `extension/worker/` -
  shared logic and infrastructure

**Do not clone or build this repository to install the server.** The published
npm package is the artifact. Building from source produces a server whose
`check_news` and `get_market` return an error, because the shared Worker URL and
key are baked in at publish time and are absent from a fresh checkout.

## Install

There is no build step and nothing to compile. Add this to the MCP settings
file and restart the client:

```json
{
  "mcpServers": {
    "actually": {
      "command": "npx",
      "args": ["actually-mcp-server"]
    }
  }
}
```

That is the whole installation. No API key, no account, no wallet.

Two tools appear:

- `check_news(text)` - matches arbitrary news text to the Polymarket market it
  is about and returns that market's probability, a confidence score, and the
  alternatives it considered
- `get_market(marketId)` - live price and an orderbook snapshot

## Verifying it worked

Ask the model to call `check_news` with any current headline. A correct
response contains `hasMarket`, `confidence`, and a `market` object with a
`question` and `probabilityYes`.

**Allow at least 15 seconds for the first call.** The first run downloads and
warms a local embedding model, and a probe that gives up after 5 seconds will
see silence and look like a broken install. Later calls are fast.

## Optional: trading

Skip this section unless the user explicitly asks for trading. It moves real
money.

The trading tools are not registered at all unless `POLYMARKET_PRIVATE_KEY` is
set. The key is the user's own Polygon EOA private key, it stays in their
process, and it is never sent anywhere except to sign their own orders.

```json
{
  "mcpServers": {
    "actually": {
      "command": "npx",
      "args": ["actually-mcp-server"],
      "env": {
        "POLYMARKET_PRIVATE_KEY": "0x...",
        "ACTUALLY_MAX_ORDER_USD": "100",
        "ACTUALLY_DAILY_LIMIT_USD": "500"
      }
    }
  }
}
```

Both caps are enforced server-side against the market's own price and held in a
ledger that survives restarts, so an agent cannot talk its way past them by
claiming a different price. `redeem_position` needs a second explicit opt-in,
`ACTUALLY_ENABLE_REDEEM=true`, because it submits an on-chain transaction and is
still in testing.

Trading is unavailable in several jurisdictions, enforced server-side. Reading
probabilities works everywhere.

## Every environment variable

All optional. The server runs with none of them.

| Variable | Effect |
|---|---|
| `POLYMARKET_PRIVATE_KEY` | Registers the trading tools. Omit for signal-only |
| `ACTUALLY_MAX_ORDER_USD` | Per-order USD cap, default 100 |
| `ACTUALLY_DAILY_LIMIT_USD` | Rolling UTC-day USD cap, default 500 |
| `ACTUALLY_ENABLE_REDEEM` | Exactly `true` also registers `redeem_position` |
| `ACTUALLY_SEARCH_FALLBACK` | Exactly `true` lets `check_news` fall back to Polymarket's own search when nothing cached matches. Off by default: that query leaves the machine |
| `ACTUALLY_SPEND_STATE_PATH` | Where the spend ledger lives, default `~/.actually-mcp-server/spend-guard.json` |
| `ACTUALLY_WORKER_URL` | Only if running your own Cloudflare Worker |
| `ACTUALLY_WORKER_SECRET` | Shared secret for your own Worker. Not a private credential: the default ships inside every client by design |

## Disclosure

Orders carry the maintainer's Polymarket builder code, their attribution
program. It costs the operator nothing extra. Reading probabilities is free and
there are no ads.
