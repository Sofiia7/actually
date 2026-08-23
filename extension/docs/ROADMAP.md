# Actually - Roadmap to v1 (post-audit)

**Status date:** 2026-07-05 (re-verified against code - see per-sprint notes below;
original write-up was 2026-06-23 and had drifted from what had actually landed).
**Canonical source of truth for remaining work.** Spec sprints 0-5 are done
(see `actually-extension-spec.md` §16). This document supersedes the "pending"
rows of spec §16 and folds in the post-audit findings.

Legend - "green" = `npx tsc --noEmit` + `npx vitest run` + `npm run build` all clean.

**2026-07-05 re-verification: Sprints 6-10 are ALL DONE**, confirmed by reading
the actual current code (not just trusting this doc), with one real gap found
and fixed in the same pass (10.7 - SECURITY.md was missing the `ws`/viem
WalletConnect-transport advisory chain; added). **Sprint 11 (beta + CWS) is the
only sprint below still open**, and it's non-code (human process). Since this
doc was last written, an unrelated agentic MCP-server layer (`packages/core`,
`packages/mcp-server`, `packages/market-cache-builder`) was also built on top
of the shared matching engine - see
`docs/superpowers/specs/2026-06-30-agentic-layer-design.md` - it does not
change anything below.

## Locked product decisions

- **Geo = build-flagged (revised in the v2.1 audit pass).** When the `/geo`
  lookup is `unknown`, behavior is governed by `GEO_FAIL_OPEN`
  (`VITE_GEO_FAIL_OPEN`): **prod builds fail closed** (trading paused until the
  region is confirmed), dev/beta builds fail open with an inline warning.
  Confirmed-restricted countries are always blocked. Polymarket still enforces
  its own block at order time. Aligned in SECURITY.md; spec §10/§5.3 updated.
- **Trade UX is wallet-gated.** Without a connected wallet the Trade tab shows
  only the odds card + "Connect wallet" - no sparkline / orderbook / resolution.
  With a wallet: full order ticket (Limit + Market) + analytics.
- **i18n = English-only for v1.** Reduce to `en`; remove i18next /
  react-i18next / locale files / language selector. Re-introduce later if a
  market needs it.

---

## v2.1 audit hardening (this pass) - landed

Beyond the sprints below (which are largely done), this pass added:

- **Worker fail-closed on unbound KV** (`worker/index.ts`): authenticated routes
  return 503 if `RATE_LIMITS` is missing in prod - supersedes the warn-only 7.4.
- **Geo build flag** `GEO_FAIL_OPEN` (prod fail-closed) + UI gating.
- **Binary-market filter** at cache entry (`isBinaryOutcomes`) - non-binary
  markets never reach the YES/NO trade flow.
- **Confirm step before signing** (spec §6.5) + **match context** (headline +
  confidence, spec §6.1) + **selectable alternates** (`onPickRelated`).
- **Build-integrity smoke** (`npm run smoke`) wired into CI; CI no-leak grep
  no longer self-matches its guard file; removed dead `Settings.locale`.

**Release-blocker status (updated 2026-06-23): the secret is rotated.** The
burned `770d0e45…` is gone from the build and `npm run preflight` passes. The
shared secret is baked into the client *by design* - it cannot be kept private
in a distributed extension; the real abuse backstop is the Worker's per-IP rate
limit + OpenAI cap, which fail closed (503) when `RATE_LIMITS` KV is unbound in
prod. CI is green on Node 24 / npm 11. The remaining gates to public launch are
**non-code**: a legal/geo review and the closed beta (Sprint 11).

---

## Sprint 6 - Trading correctness + order ticket ✅ done (verified 2026-07-05)

| ID | Exact change | Files | Acceptance |
|---|---|---|---|
| 6.1 | Move `<MarketAnalytics>` inside the `wallet ?` branch of `TradeReady`. No-wallet Trade = odds card (IceCard) + `<ConnectPanel>` only. ResolutionCard gated with analytics. | `popup_new/TradeTabWired.tsx` | No-wallet Trade has no sparkline/orderbook/resolution |
| 6.2 | Update smoke row that promised "orderbook without wallet" | `docs/release-checklist.md` | Checklist matches behavior |
| 6.3 | `/history` upstream `gamma-api…/prices-history` → `https://clob.polymarket.com/prices-history` | `worker/index.ts` | Correct host |
| 6.4 | `OS_PRICE_HISTORY` params → `market`, `startTs=now-7d`, `endTs=now`, `fidelity=60`; drop `interval=1h`. Keep `{history:[{t,p}]}` mapping | `offscreen.ts` | Sparkline shows real 7d trend (connected) |
| 6.5 | Order ticket UI: Limit/Market toggle; editable price (`step=tickSize`, default = side best ask); shares/payout/return recompute; depth-based fill estimate; maker/taker hint | `popup_new/TradeTabWired.tsx` (`OrderFormWired`) + new `popup_new/trade/orderMath.ts` | User sets own limit price; sees maker/taker + estimate |
| 6.6 | `OS_ORDERBOOK_SNAPSHOT` accepts optional `sizeShares`; `OS_ORDERBOOK` returns `estimate?: {effectivePrice, slippage}` via existing `estimateBuy` | `shared/messages.ts`, `offscreen.ts`, `popup_new/ops.ts` | Ticket shows depth-based estimate |
| 6.7 | Add `orderType: 'LIMIT' \| 'MARKET'` through `OffscreenPlaceOrderArgs` → `PlaceOrderArgs`. Limit→`OrderType.GTC` at user price; Market→`OrderType.FOK`, limit = `bestAsk×(1+cap)` (cap default 2%), reject on insufficient depth. Confirm SDK method names at impl. | `shared/messages.ts`, `background/trade.ts`, `background/clob.ts`, `offscreen.ts` | GTC rests; FOK fills-or-kills with cap |
| 6.8 | `order_submitted` meta: add `order_type`, `maker_taker` | `background/trade.ts` | Events carry order type |
| 6.9 | New-user (POLY_1271): on `funder_not_found` show explicit "v1 supports existing Polymarket Safe; deposit wallets (POLY_1271) coming soon". Full sigType-3 support only if cheap; else → Post-v1 | `background/clob.ts`, `popup_new/TradeTabWired.tsx` | New user gets a clear message |

Tests (TDD): `orderMath` (shares/payout/return, tick, maker/taker, FOK cap). ✅
`orderMath.test.ts` (19 tests) + `TradeTabWired.test.tsx` cover wallet-gating,
slippage>20% disable, and the confirm-before-sign step.

## Sprint 7 - Worker hardening ✅ done (verified 2026-07-05)

| ID | Exact change | Files |
|---|---|---|
| 7.1 | `/embeddings` input validation: `texts` array; `len ≤ 64`; each `≤ 2000` chars; total `≤ 20000`; body `≤ 256KB` → 400/413 | `worker/index.ts` |
| 7.2 | OpenAI daily quota counted by chars (≈tokens), KV `openai_chars_day:<date>`, cap from env | `worker/index.ts` |
| 7.3 | `/telemetry` persist to Analytics Engine or D1 (not `console.log`); add binding | `worker/index.ts`, `worker/wrangler.toml(.example)` |
| 7.4 | `console.warn` once when `RATE_LIMITS` KV unbound (fail-open visibility) | `worker/index.ts` |

All four confirmed live in `worker/index.ts`, covered by `worker.test.ts`/
`embeddings-validation.test.ts`/`market-cache-validation.test.ts` (46 tests total).

**2026-07-08 addendum:** 7.2's KV-based `openai_chars_day` counter (and the
per-IP limiter it shared a pattern with) had a non-atomic read-then-write -
concurrent requests could both read the same stale count and increment from
it, letting a determined caller exceed the nominal limit several times over
under concurrency. Replaced with `RateLimiterDO`, a Durable Object that does
an atomic check-and-increment (Cloudflare guarantees one instance processes
one request at a time, closing the race with no extra locking code). `env.RATE_LIMITS`
KV binding removed; `env.RATE_LIMITER_DO` added, wired via `wrangler.toml`'s
`[[durable_objects.bindings]]` + `[[migrations]]`. Requires the Workers Paid
plan (Durable Objects aren't on Workers Free) - see `README.md`.

## Sprint 8 - Secrets, geo posture, build hygiene ✅ done (verified 2026-07-05)

| ID | Exact change | Files |
|---|---|---|
| 8.1 | Rotate `WORKER_SHARED_SECRET` (wrangler + `.env.local`); ensure `770d0e45…` gone; move secrets out of OneDrive sync | `.env.local`, CF |
| 8.2 | Rewrite spec §10/§5.3 + SECURITY.md to document geo fail-open | `actually-extension-spec.md`, `SECURITY.md` |
| 8.3 | Add telemetry `geo_unknown`; emit in `connectWallet`/`placeOrder` on unknown | `shared/types.ts`, `background/trade.ts` |
| 8.4 | Pin Node 20 (`engines.node`); README note on non-ASCII/OneDrive build paths | `package.json`, `README.md` |

**2026-07-05 addendum (found during re-verification, not in the original
8.x list):** the CA-ON check in `/geo` read `CF-Region-Code` as an HTTP
*header* - Cloudflare never sends region as a header to a Worker, only via
`request.cf.regionCode`. Ontario would silently never have been geo-blocked
in production despite the existing test passing (the test injected the same
wrong header). Fixed in `worker/index.ts` + regression test added in
`worker.test.ts` asserting a spoofed `CF-Region-Code` header is ignored.

## Sprint 9 - Tests & CI (finishes spec Sprint 6) ✅ done (verified 2026-07-05)

| ID | Exact change | Files |
|---|---|---|
| 9.1 | Miniflare worker tests: auth (401/503/dev), CORS fail-closed, `/geo` (US/CA-ON/RS/extra), rate-limit 429, `/history`, `/orderbook`, `/embeddings` limits | `worker/*.test.ts` (new), `package.json` |
| 9.2 | Component tests (RTL): CheckTab links, YES/NO map, ticket math, slippage>20% disable, analytics gated by wallet, Limit/Market toggle | `popup_new/*.test.tsx` (new) |
| 9.3 | `matcher.test.ts` imports real functions instead of copy-paste | `background/matcher.ts`, `matcher.test.ts` |

9.3 is moot rather than done-as-written: the matcher moved to `@actually/core`
entirely during the agentic-layer work (dependency-injected `findMatch`), so
there's no extension-local `matcher.ts`/`matcher.test.ts` left to deduplicate -
its tests live in `packages/core/src/matcher.test.ts` (13 tests) instead.

## Sprint 10 - Cleanup & honesty ✅ done (verified 2026-07-05)

| ID | Exact change | Files |
|---|---|---|
| 10.1 | **i18n → English-only:** remove `i18next`/`react-i18next`, `i18n/*` locale files, language selector; inline `en` strings | `popup_new/*`, `popup/main.tsx`, `i18n/*`, `package.json` |
| 10.2 | Wire Cache TTL §12 lazy refresh in `OS_RUN_MATCH`; delete dead `runMatch`/`maybeRefreshStaleCache`/`runRefresh` | `offscreen.ts`, `popup/operations.ts` |
| 10.3 | Remove dead `lastMatchByUrl`; fix stale comments (`embeddings`, `ops`, `clob`, `matcher`, `constants`, `cache`) | `shared/constants.ts`, `background/*` |
| 10.4 | `offscreen-host.ts` fallback returns real `hasDocument()` value | `background/offscreen-host.ts` |
| 10.5 | Drop unused `personal_sign` from WC namespace; update spec §7 | `background/wallet.ts`, `actually-extension-spec.md` |
| 10.6 | QR via `QRCode.toDataURL` + `<img>` instead of `dangerouslySetInnerHTML` | `popup_new/TradeTabWired.tsx` |
| 10.7 | Correct npm-audit triage in SECURITY.md (onnx exercised, trusted CDN) | `SECURITY.md` |
| 10.8 | Remove dead `popup_new/Popup.tsx` if unused; resolve untracked `design/` | `popup_new/Popup.tsx`, `.gitignore` |

10.1-10.6 and 10.8 were already landed and re-verified clean by grep (no
`personal_sign`, no dead `popup_new/Popup.tsx`, no untracked `design/`, TTL
wired). **10.7 had a real gap**, fixed 2026-07-05: `npm audit` on the live
tree shows a high-severity `ws` chain via
`@walletconnect/jsonrpc-ws-connection` → `viem` that SECURITY.md didn't
address at all. Confirmed the vulnerable `require('ws')` branch is present as
dead bytes in the built `offscreen-*.js` (string-verified) but unreachable at
runtime - the offscreen document always has `self.WebSocket`. Documented in
`SECURITY.md`'s npm-audit-triage section.

## Sprint 11 - Beta + CWS (spec Sprint 7) ⚪ still open - non-code, human process

1. Prod build with rotated `.env.local`; verify dist CSP single origin + host_permissions = clob only.
2. Clean-Chrome smoke per updated `release-checklist.md` (discovery → connect → limit → market FOK → disconnect&wipe → telemetry off).
3. CWS assets: 3-5 screenshots, promo images, privacy URL, single-purpose + permission justifications.
4. Closed beta: 10-20 crypto-native + 10-20 normie; collect KPIs (computable after 7.3).
5. Sprint 12 = beta fixes → public launch (Product Hunt + CryptoTwitter).

## Post-v1 (parked)

- ~~**v1.1:** bundle MiniLM-L12 weights into .crx → drop `huggingface.co` from CSP~~ -
  **landed 2026-07-07.** `npm run models:fetch` bundles the model weights +
  onnxruntime-web WASM; `huggingface.co`/`*.hf.co`/`cdn.jsdelivr.net` removed
  from CSP; extension is fully offline-installable.
- **v1.2:** HMAC `X-Actually-Auth` (timestamp+nonce+body) + Worker `POST /clob/order` proxy → remove clob `host_permissions`; server-side geo re-check on submit.
- Full POLY_1271 / deposit-wallet support (if deferred from 6.9).
- Full EIP-55 checksum in `wallet.ts`.
- In-page Shadow-DOM widget (spec §15, opt-in via explicit `chrome.permissions.request` if revived).

This list is engineering-scope only (auth/geo/wallet hardening). The separate
product-feature backlog (sell-to-close, multi-market per page, Safari port,
in-page widget toggle) lives in `README.md`'s Roadmap section, deliberately
un-numbered there to avoid the same version label meaning two different
things in two documents again. (Order status polling and a position list
were on that backlog too, but both shipped - open positions with cost basis/
P&L and resting orders with live status + in-app cancel are in the Trade tab
now; see README.md's Status table.)

## Critical path

Sprints 6-10 are done. **Sprint 11 (beta + CWS) is the entire remaining
critical path** to public launch - it is a human/process gate (recruit
testers, capture screenshots, submit to the Chrome Web Store, run the closed
beta), not an engineering task. No further code changes block it.
