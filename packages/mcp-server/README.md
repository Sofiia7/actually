# actually-mcp-server

MCP server that maps news text to Polymarket markets and returns the market's
**current probability** - the piece existing Polymarket MCP servers don't
provide. Existing servers hand an agent raw market data (`price`, `volume`,
`orderbook`); this one answers "what does the market actually think about
*this specific news text*." That's a real, unmodified market price - not a
number this server invents from the text's tone - but it is the crowd's
current bet, not a verdict on whether the news itself is true.

## Install

```bash
npx actually-mcp-server
```

Or add to your MCP client config (Claude Code, Cursor, etc.) pointing at
`npx actually-mcp-server`. The published package already has the maintainer's
Worker URL + shared secret baked in (same mechanism as the builder code
below), so `check_news`/`get_market` work with **zero required env vars**.
For Claude Desktop / Claude Code (`.mcp.json` or `claude_desktop_config.json`):

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

To enable trading (`place_order`/`sell_order`/etc.), add your own key:

```json
{
  "mcpServers": {
    "actually": {
      "command": "npx",
      "args": ["actually-mcp-server"],
      "env": {
        "POLYMARKET_PRIVATE_KEY": "0xyour-own-private-key-never-committed",
        "ACTUALLY_MAX_ORDER_USD": "100",
        "ACTUALLY_DAILY_LIMIT_USD": "500"
      }
    }
  }
}
```

Omit `POLYMARKET_PRIVATE_KEY` (and the two caps) entirely to run signal-only.
Only set `ACTUALLY_WORKER_URL`/`ACTUALLY_WORKER_SECRET` if you're running your
own Worker instead of the shared default one. See `.env.example` in this
package for all variables documented for local dev/testing outside an MCP
client.

## Tools

| Tool | Requires a key? | What it does |
|---|---|---|
| `check_news(text)` | No | Maps arbitrary news text to the relevant Polymarket market; returns its current YES probability, confidence, and up to 3 alternative candidate markets. Does not classify tone - that's left to you, the calling agent. |
| `get_market(marketId)` | No | Market details, live price, and an orderbook snapshot for a market you already have the id for (e.g. from `check_news`). Falls back to a direct Gamma lookup when the id is outside the precomputed cache. |
| `place_order(marketId, side, sizeUsd, price, orderType)` | Yes (`POLYMARKET_PRIVATE_KEY`) | Buys YES or NO shares. The token to trade is resolved **server-side** from `marketId` + `side` - you cannot pass a raw token id, so a mismatched side/token can't silently buy the wrong outcome. Rejects non-Yes/No (categorical) markets outright rather than guessing an outcome. Gated on the same jurisdiction check as the browser extension (see below). Capped by `ACTUALLY_MAX_ORDER_USD` / `ACTUALLY_DAILY_LIMIT_USD` (see below). |
| `sell_order(marketId, side, sizeShares, price, orderType)` | Yes | Sells YES or NO shares you hold - closes or reduces a position. Same non-binary-market rejection and jurisdiction gate as `place_order`. Shares the same daily budget as `place_order` (notional estimated as `sizeShares × price`). |
| `cancel_order(orderId)` | Yes | Cancels one of your resting orders. |
| `get_open_orders(marketId?)` | Yes | Lists your resting orders, optionally filtered to one market. |
| `get_positions()` | Yes | Lists your current positions with cost basis and unrealized P&L (Polymarket data-api). A `redeemable: true` position has resolved and is ready for `redeem_position`. |
| `redeem_position(conditionId)` | Yes + `ACTUALLY_ENABLE_REDEEM=true` | Claims payout for a resolved, winning position - get the `conditionId` from `get_positions`. **Not a CLOB order.** This is an on-chain transaction (calling either the base Conditional Tokens contract or Polymarket's NegRiskAdapter, depending on the market), submitted through Polymarket's own relayer since your positions are held by your Polymarket Safe, not your raw wallet. No POL/gas needed - Polymarket's relayer covers it, the same way it does for their own website's redeem button. Not subject to the spend guard (it claims money owed to you; it never risks new capital). |

`place_order`/`sell_order`/`cancel_order`/`get_open_orders`/`get_positions` are only registered when `POLYMARKET_PRIVATE_KEY` is set - without it, this server only exposes the two signal tools above. `redeem_position` needs that **and** `ACTUALLY_ENABLE_REDEEM=true` - see the next section for why it's gated separately.

### Redeeming positions - read this before you rely on it

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
available to test against in the environment this was built in. Unlike
`place_order`/`sell_order`, a bug here has no CLOB-rejection safety net - it's
a real on-chain transaction, so a mistake risks a genuinely lost or stuck
payout rather than just a rejected order. For that reason the tool is not
registered at all - an agent enumerating tools won't even see it - unless you
set `ACTUALLY_ENABLE_REDEEM=true`, a second explicit opt-in beyond just
configuring `POLYMARKET_PRIVATE_KEY`. Before setting it, do one manual
`redeem_position` call against a small real resolved position yourself and
confirm the payout lands.

This feature also pulls in `@polymarket/builder-relayer-client` (which
depends on `ethers@5`, `viem`, and an old `axios@0.27` with several
high/critical-severity advisories with no available fix - evaluate whether
that tradeoff is acceptable for your deployment) and adds noticeable cold-start
latency: server startup went from near-instant to **~2.6s** in local testing
because of this dependency's size, even when `redeem_position` is never called.

**Triage (checked 2026-07-08):** `@polymarket/builder-relayer-client`'s latest
published version (`0.0.10`, already what installs today) still pins
`axios@^0.27.2` directly - there is no newer release to upgrade to, and this
project has no way to patch a third party's dependency choice. We did **not**
force an `overrides` bump of the transitive `axios`/`ethers` versions: axios
0.27→1.x is a semver-major jump with breaking changes to request/transform
behavior, and silently overriding it on the one code path that submits a real
on-chain transaction - one this README already flags as never tested against
real mainnet funds - is a worse risk than the advisories themselves without a
dedicated live test to confirm nothing broke. Most of axios's current
advisories require an attacker-influenced request URL or response body to be
reachable (SSRF via absolute/attacker URLs, prototype pollution via
untrusted response merging); `relayerClient.ts` only ever calls a hardcoded
`https://relayer-v2.polymarket.com/` (see `RELAYER_URL`), never a caller- or
market-supplied URL, which narrows the practically-exploitable surface here
considerably even though the advisories remain unpatched upstream. Operators
who want the axios/ethers versions bumped regardless should pin an
`overrides` entry in their own `package.json` and re-run the manual
`redeem_position` mainnet test above before trusting it.

**Removed:** `prepare_order` (returning an "unsigned order to sign elsewhere") was cut before publish - `@polymarket/clob-client-v2`'s `createOrder`/`createMarketOrder` sign internally with no public API to construct genuine unsigned EIP-712 typed data, so the tool could never honestly deliver on "sign this exact object unchanged." If you need a sign-elsewhere flow, run your own `ClobClient` with a custom signer instead.

## Local embedding dependency

**Fixed 2026-09-28 (audit F11).** `check_news` embeds text with
`@xenova/transformers@2.17.2`, which depends on `onnxruntime-web@1.14.0` ->
`onnx-proto` -> `protobufjs@6.11.6` (critical per `npm audit`) and on
`sharp@0.32` (high). The monorepo's `overrides` never reached a consumer's
install, because npm only applies the overrides of the install root.

The published package now bundles `@xenova/transformers` into `dist/` at build
time and swaps `onnxruntime-web` and `sharp` for stubs (`tsup.config.ts`,
`src/stubs/`): under Node the library only ever runs on `onnxruntime-node`, and
this server only embeds text. A consumer install contains no
`onnxruntime-web`, `onnx-proto`, `protobufjs` or `sharp` at all.
`onnxruntime-node@1.14.0`, the engine that actually runs the model, is a direct
dependency - the same version as before, so embeddings are bit-identical to the
unbundled library (checked on English, Cyrillic and number-heavy text). The
install also shrank: 220 tarballs / ~171 MB compressed instead of 294 / ~206 MB.

The model itself is fetched lazily on the first `check_news` call, pinned to an
immutable commit (`LOCAL_MODEL_REVISION`, shared from `@actually/core` with the
extension). The commit pin is the integrity guarantee here; the extension goes
further and verifies each file's SHA-256 when it bakes the model in at build
time.

Moving to `@huggingface/transformers` is no longer needed for security, and
would cost size: `onnxruntime-node@1.30.0` alone is 301 MB unpacked. An attempt
on 2026-07-24 also hit `ERR_DLOPEN_FAILED` loading that native binding on
Windows. Re-evaluate only if 2.17.2 stops working.

Still flagged in a consumer install, and why they stay:
- `axios@0.27.2` via `@polymarket/builder-relayer-client@0.0.10` (its latest
  release pins `^0.27.2`). The advisories need an attacker-chosen URL or cookie;
  this package only calls fixed Polymarket hosts. Moving it to axios 1.x
  changes the `Content-Type` of the relayer `/submit` request, which cannot be
  verified without a live redeem - so it waits for Polymarket's own update.
- `ws@8.18.0` via ethers v5 (`@ethersproject/providers`). It backs ethers'
  WebSocketProvider, which this package never constructs.

## `@modelcontextprotocol/sdk` - a moderate advisory with no better version to move to

`npm audit` flags `@hono/node-server` (bundled by the SDK) for a path-traversal
bug in its `serve-static` feature on Windows (GHSA-frvp-7c67-39w9). Every SDK
release from 1.25.0 through the current latest (1.29.0, what this package
pins) bundles a vulnerable hono version - upstream hasn't re-paired the SDK
with a patched hono yet. npm's own suggested fix is to downgrade to `1.24.3`,
the last release *before* the vulnerable hono dependency was introduced - that
would trade newer SDK fixes/features for an advisory that doesn't apply to us
anyway: this server only ever constructs `StdioServerTransport` (see
`src/index.ts`), never the HTTP transport that would exercise
`@hono/node-server`'s static-file serving at all. Staying on latest (1.29.0)
and tracking upstream's next hono bump is the right call here, not a
downgrade for a code path we never reach.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `ACTUALLY_WORKER_URL` | No | Overrides the baked-in default Worker base URL - only needed if you run your own Worker. |
| `ACTUALLY_WORKER_SECRET` | No | Overrides the baked-in default shared read secret. This is public-by-design (the same posture as the browser extension's baked secret) - the real backstop is server-side rate limiting, not secrecy. |
| `POLYMARKET_PRIVATE_KEY` | No | Your own Polygon EOA private key. **We never see this** - it stays in your own process environment. Enables `place_order`/`sell_order`/`cancel_order`/`get_open_orders`/`get_positions`. Never commit it; never share it with anyone, including us. |
| `ACTUALLY_SEARCH_FALLBACK` | No | Set to exactly `true` to let `check_news` fall back to Polymarket's own market search when nothing in the cached ~2000-market set clears the floor. Off by default: the query is built from the caller's text and leaves this machine. With it off, a miss still reports `nearest` and `marketsCompared`, so an agent can tell "nothing on this subject" from "below the cache cut". |
| `ACTUALLY_ENABLE_REDEEM` | No | Set to exactly `true` to additionally register `redeem_position`. See "Redeeming positions" above - this is a real on-chain transaction, **still in testing**: as of 2026-08-21 builder auth, neg-risk contract selection and the zero-balance guard are each verified against live services, but no redeem has yet been observed actually collecting funds. Needs an explicit second opt-in beyond `POLYMARKET_PRIVATE_KEY`. |
| `ACTUALLY_MAX_ORDER_USD` | No | Per-order cap for `place_order`/`sell_order` (default **$100**). Rejects any single order above this notional before it's ever signed. |
| `ACTUALLY_DAILY_LIMIT_USD` | No | Rolling UTC-day cap shared by `place_order`+`sell_order` (default **$500**). Persisted to `ACTUALLY_SPEND_STATE_PATH` (see below) so it survives a process restart - still not a substitute for real accounting. |
| `ACTUALLY_SPEND_STATE_PATH` | No | Where the daily-spend counter is persisted (default `~/.actually-mcp-server/spend-guard.json`). Most MCP clients spawn this server as a fresh subprocess per session, so without persistence the "daily" limit reset on every restart, not just once a day. Override for a custom deployment layout or to isolate multiple operators on one machine. |

These two caps exist because an MCP server that signs real orders on an agent's behalf is exposed to prompt injection: a compromised or buggy calling agent could otherwise try to place unbounded orders. Set both explicitly for any unattended/production use - do not rely on the defaults for anything beyond testing.

## Jurisdiction gate

`place_order`/`sell_order` check the same Worker `/geo` endpoint the browser
extension uses before signing anything, and refuse to trade (`error:
"geo_blocked"`) from a jurisdiction where Polymarket restricts trading, or
where the lookup itself fails (fail-closed, matching the extension). This
resolves the network location of wherever this server process runs - an
operator running it on a VPS in a different country than they physically are
should account for that. `check_news`/`get_market` are never gated; only
order placement carries this obligation.

## The builder code

Every order this server signs (`place_order`/`sell_order`) carries a builder
code that attributes trading flow to the maintainers, the same way the
companion browser extension's builder code works. This is disclosed here,
not hidden: order-flow attribution is how this tool is funded, and it costs
you nothing beyond whatever fee split Polymarket's builder program applies -
you are never charged extra by us. `redeem_position` carries no builder code
- it's an on-chain claim of money you already own, not routed order flow.

## Notes on cold start

The very first `npx actually-mcp-server` downloads about 171 MB of packages,
and the embedder (local MiniLM) downloads a ~34 MB ONNX model on its *first*
`check_news` call, not on server startup - an operator using only the trading
tools never pays that part. On a slow connection the first launch can outlast a
client's start-up timeout; running `npx -y actually-mcp-server` once in a
terminal fills the cache, and later launches start in seconds.

Separately, `@polymarket/builder-relayer-client` (needed for `redeem_position`)
adds ~2-3s to every server *startup* regardless of which tools you actually
use, since its dependency tree (`viem`, `ethers@5`, `axios`) is imported
eagerly at module load - this is a one-time-per-process cost, not per-call.

## Maintainer: before the first real `npm publish`

- [x] Confirm `actually-mcp-server` is available on the public npm registry - verified 2026-07-05 (`registry.npmjs.org/actually-mcp-server` → 404).
- [x] Flip `"private": true` to `"private": false` in `packages/mcp-server/package.json` - done.
- [x] Build + `npm pack --dry-run` sanity check (3 files, `dist/index.js` ~33KB with `@actually/core` bundled in, `node dist/index.js < /dev/null` starts and exits clean) - verified 2026-07-05.
- [ ] Set `ACTUALLY_BUILDER_CODE`, `ACTUALLY_WORKER_URL`, and `ACTUALLY_WORKER_SECRET` (same values as `extension/.env.local`'s `VITE_BUILDER_CODE`/`VITE_WORKER_URL`/`VITE_WORKER_SECRET`) before running `npm run build` - these are read once by `tsup.config.ts` at build time and baked into `dist/index.js` so a plain `npx actually-mcp-server` works with zero required env vars. The builder code **needs the maintainer's own Polymarket builder-program registration** (`polymarket.com/settings?tab=builder`); not something anyone else can do on your behalf.
- [ ] Confirm the R1 open risk from the design spec (Polymarket builder-program ToS re: baking the code into a third-party-operated open-source server) has been checked - see `docs/superpowers/specs/2026-06-30-agentic-layer-design.md`. **Not blocking** for publishing the signal-only tools (`check_news`/`get_market`), only for shipping a non-empty builder code.
- [ ] `npm login` (or set an `NPM_TOKEN`), then `npm publish` from `packages/mcp-server`.
- [ ] Submit to MCP marketplaces (mcpmarket.com, playbooks.com, claudemarketplaces.com) per the original packaging discussion.
- [x] 2026-08-02: package metadata staged for 0.1.4 - versions ≤0.1.3 shipped with ONLY `name`+`version` (empty npm listing page, nothing for MCP directories to scrape). Added `description`, `keywords`, `license: MIT` (matches root LICENSE, now copied into the package dir so npm bundles it), and `mcpName: io.github.sofiia7/actually` (required by the official MCP registry; must match `server.json` - see `marketing/submissions/mcp-directories.md`). `repository`/`homepage` deliberately left out until the repo (or a public mirror of this package) exists - a 404ing GitHub link in a fresh npm listing reads worse than no link.
