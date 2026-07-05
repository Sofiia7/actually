# actually-mcp-server

MCP server that maps news text to Polymarket markets and returns the market's
**objective probability** — the piece existing Polymarket MCP servers don't
provide. Existing servers hand an agent raw market data (`price`, `volume`,
`orderbook`); this one answers "what does the market actually think about
*this specific news text*."

## Install

```bash
npx actually-mcp-server
```

Or add to your MCP client config (Claude Code, Cursor, etc.) pointing at
`npx actually-mcp-server` with the environment variables below.

## Tools

| Tool | Requires a key? | What it does |
|---|---|---|
| `check_news(text)` | No | Maps arbitrary news text to the relevant Polymarket market; returns its objective YES probability, confidence, and up to 3 alternative candidate markets. Does not classify tone — that's left to you, the calling agent. |
| `get_market(marketId)` | No | Market details, live price, and an orderbook snapshot for a market you already have the id for (e.g. from `check_news`). Falls back to a direct Gamma lookup when the id is outside the precomputed cache. |
| `place_order(marketId, side, sizeUsd, price, orderType)` | Yes (`POLYMARKET_PRIVATE_KEY`) | Buys YES or NO shares. The token to trade is resolved **server-side** from `marketId` + `side` — you cannot pass a raw token id, so a mismatched side/token can't silently buy the wrong outcome. Capped by `ACTUALLY_MAX_ORDER_USD` / `ACTUALLY_DAILY_LIMIT_USD` (see below). |
| `sell_order(marketId, side, sizeShares, price, orderType)` | Yes | Sells YES or NO shares you hold — closes or reduces a position. Shares the same daily budget as `place_order` (notional estimated as `sizeShares × price`). |
| `cancel_order(orderId)` | Yes | Cancels one of your resting orders. |
| `get_open_orders(marketId?)` | Yes | Lists your resting orders, optionally filtered to one market. |
| `get_positions()` | Yes | Lists your current positions with cost basis and unrealized P&L (Polymarket data-api). A `redeemable: true` position has resolved and is ready for `redeem_position`. |
| `redeem_position(conditionId)` | Yes | Claims payout for a resolved, winning position — get the `conditionId` from `get_positions`. **Not a CLOB order.** This is an on-chain transaction (calling either the base Conditional Tokens contract or Polymarket's NegRiskAdapter, depending on the market), submitted through Polymarket's own relayer since your positions are held by your Polymarket Safe, not your raw wallet. No POL/gas needed — Polymarket's relayer covers it, the same way it does for their own website's redeem button. Not subject to the spend guard (it claims money owed to you; it never risks new capital). |

`place_order`/`sell_order`/`cancel_order`/`get_open_orders`/`get_positions`/`redeem_position` are only registered when `POLYMARKET_PRIVATE_KEY` is set — without it, this server only exposes the two signal tools above.

### Redeeming positions — read this before you rely on it

`redeem_position` was implemented and unit-tested against the exact, verified
Polygon contract ABIs (Conditional Tokens `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`,
NegRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`, collateral pUSD
`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, both cross-checked against
PolygonScan's contract ABI and docs.polymarket.com) and against the real,
installed `@polymarket/builder-relayer-client`'s actual exported classes and
source (not just its docs). The MCP tool boots correctly, registers, and
round-trips through a real `child_process` JSON-RPC exchange in development.

**What has NOT been verified: an actual redeem against Polygon mainnet with a
real wallet holding a real resolved position.** There was no such wallet
available to test against in the environment this was built in. Before
trusting this in an unattended agent flow, do one manual `redeem_position`
call against a small real resolved position and confirm the payout lands.

This feature also pulls in `@polymarket/builder-relayer-client` (which
depends on `ethers@5`, `viem`, and an old `axios@0.27` with several
high/critical-severity advisories with no available fix — evaluate whether
that tradeoff is acceptable for your deployment) and adds noticeable cold-start
latency: server startup went from near-instant to **~2.6s** in local testing
because of this dependency's size, even when `redeem_position` is never called.

**Removed:** `prepare_order` (returning an "unsigned order to sign elsewhere") was cut before publish — `@polymarket/clob-client-v2`'s `createOrder`/`createMarketOrder` sign internally with no public API to construct genuine unsigned EIP-712 typed data, so the tool could never honestly deliver on "sign this exact object unchanged." If you need a sign-elsewhere flow, run your own `ClobClient` with a custom signer instead.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `ACTUALLY_WORKER_URL` | Yes | The backing worker's base URL. |
| `ACTUALLY_WORKER_SECRET` | Yes | Shared read secret for the worker's proxy routes. This is public-by-design (the same posture as the browser extension's baked secret) — the real backstop is server-side rate limiting, not secrecy. |
| `POLYMARKET_PRIVATE_KEY` | No | Your own Polygon EOA private key. **We never see this** — it stays in your own process environment. Enables `place_order`/`sell_order`/`cancel_order`/`get_open_orders`/`get_positions`. Never commit it; never share it with anyone, including us. |
| `ACTUALLY_MAX_ORDER_USD` | No | Per-order cap for `place_order`/`sell_order` (default **$100**). Rejects any single order above this notional before it's ever signed. |
| `ACTUALLY_DAILY_LIMIT_USD` | No | Rolling UTC-day cap shared by `place_order`+`sell_order` (default **$500**). In-memory only — resets on process restart, not a substitute for real accounting. |

These two caps exist because an MCP server that signs real orders on an agent's behalf is exposed to prompt injection: a compromised or buggy calling agent could otherwise try to place unbounded orders. Set both explicitly for any unattended/production use — do not rely on the defaults for anything beyond testing.

## The builder code

Every order this server signs (`place_order`/`sell_order`) carries a builder
code that attributes trading flow to the maintainers, the same way the
companion browser extension's builder code works. This is disclosed here,
not hidden: order-flow attribution is how this tool is funded, and it costs
you nothing beyond whatever fee split Polymarket's builder program applies —
you are never charged extra by us. `redeem_position` carries no builder code
— it's an on-chain claim of money you already own, not routed order flow.

## Notes on cold start

The embedder (`@xenova/transformers`, local MiniLM) downloads a ~33MB ONNX
model on its *first* `check_news` call, not on server startup — an operator
using only the trading tools never pays this cost. Expect the first
`check_news` call in a fresh install to take longer than subsequent ones.

Separately, `@polymarket/builder-relayer-client` (needed for `redeem_position`)
adds ~2-3s to every server *startup* regardless of which tools you actually
use, since its dependency tree (`viem`, `ethers@5`, `axios`) is imported
eagerly at module load — this is a one-time-per-process cost, not per-call.

## Maintainer: before the first real `npm publish`

- [x] Confirm `actually-mcp-server` is available on the public npm registry — verified 2026-07-05 (`registry.npmjs.org/actually-mcp-server` → 404).
- [x] Flip `"private": true` to `"private": false` in `packages/mcp-server/package.json` — done.
- [x] Build + `npm pack --dry-run` sanity check (3 files, `dist/index.js` ~33KB with `@actually/core` bundled in, `node dist/index.js < /dev/null` starts and exits clean) — verified 2026-07-05.
- [ ] Set `ACTUALLY_BUILDER_CODE` to the real production builder code before running `npm run build` — **needs the maintainer's own Polymarket builder-program registration** (`polymarket.com/settings?tab=builder`); not something anyone else can do on your behalf.
- [ ] Confirm the R1 open risk from the design spec (Polymarket builder-program ToS re: baking the code into a third-party-operated open-source server) has been checked — see `docs/superpowers/specs/2026-06-30-agentic-layer-design.md`. **Not blocking** for publishing the signal-only tools (`check_news`/`get_market`), only for shipping a non-empty builder code.
- [ ] `npm login` (or set an `NPM_TOKEN`), then `npm publish` from `packages/mcp-server`.
- [ ] Submit to MCP marketplaces (mcpmarket.com, playbooks.com, claudemarketplaces.com) per the original packaging discussion.
