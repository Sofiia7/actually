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
| `get_market(marketId)` | No | Market details, live price, and an orderbook snapshot for a market you already have the id for (e.g. from `check_news`). |
| `prepare_order(...)` | No | Builds an UNSIGNED order carrying this server's builder code, for callers who sign with their own wallet tooling. The builder code only survives if you sign the returned object unchanged. |
| `place_order(...)` | Yes (`POLYMARKET_PRIVATE_KEY`) | Signs and submits a real order using your configured key. Only registered when the key is present. |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `ACTUALLY_WORKER_URL` | Yes | The backing worker's base URL. |
| `ACTUALLY_WORKER_SECRET` | Yes | Shared read secret for the worker's proxy routes. This is public-by-design (the same posture as the browser extension's baked secret) — the real backstop is server-side rate limiting, not secrecy. |
| `POLYMARKET_PRIVATE_KEY` | No | Your own Polygon EOA private key. **We never see this** — it stays in your own process environment. Only enables `place_order`. Never commit it; never share it with anyone, including us. |

## The builder code

Every order this server signs (`place_order`) or prepares (`prepare_order`)
carries a builder code that attributes trading flow to the maintainers, the
same way the companion browser extension's builder code works. This is
disclosed here, not hidden: order-flow attribution is how this tool is
funded, and it costs you nothing beyond whatever fee split Polymarket's
builder program applies — you are never charged extra by us.

## Notes on cold start

The embedder (`@xenova/transformers`, local MiniLM) downloads a ~33MB ONNX
model on its *first* `check_news` call, not on server startup — an operator
using only `place_order`/`prepare_order` never pays this cost. Expect the
first `check_news` call in a fresh install to take longer than subsequent
ones.

## Maintainer: before the first real `npm publish`

- [ ] Confirm `actually-mcp-server` is available on the public npm registry (`npm view actually-mcp-server` should 404); rename in `package.json` if taken.
- [ ] Flip `"private": true` to `"private": false` in `packages/mcp-server/package.json`.
- [ ] Set `ACTUALLY_BUILDER_CODE` to the real production builder code before running `npm run build`.
- [ ] Confirm the R1 open risk from the design spec (Polymarket builder-program ToS re: baking the code into a third-party-operated open-source server) has been checked — see `docs/superpowers/specs/2026-06-30-agentic-layer-design.md`.
- [ ] Submit to MCP marketplaces (mcpmarket.com, playbooks.com, claudemarketplaces.com) per the original packaging discussion.
