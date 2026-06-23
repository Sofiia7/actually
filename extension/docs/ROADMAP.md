# Actually — Roadmap to v1 (post-audit)

**Status date:** 2026-06-23
**Canonical source of truth for remaining work.** Spec sprints 0–5 are done
(see `actually-extension-spec.md` §16). This document supersedes the "pending"
rows of spec §16 and folds in the post-audit findings.

Legend — "green" = `npx tsc --noEmit` + `npx vitest run` + `npm run build` all clean.

## Locked product decisions

- **Geo = build-flagged (revised in the v2.1 audit pass).** When the `/geo`
  lookup is `unknown`, behavior is governed by `GEO_FAIL_OPEN`
  (`VITE_GEO_FAIL_OPEN`): **prod builds fail closed** (trading paused until the
  region is confirmed), dev/beta builds fail open with an inline warning.
  Confirmed-restricted countries are always blocked. Polymarket still enforces
  its own block at order time. Aligned in SECURITY.md; spec §10/§5.3 updated.
- **Trade UX is wallet-gated.** Without a connected wallet the Trade tab shows
  only the odds card + "Connect wallet" — no sparkline / orderbook / resolution.
  With a wallet: full order ticket (Limit + Market) + analytics.
- **i18n = English-only for v1.** Reduce to `en`; remove i18next /
  react-i18next / locale files / language selector. Re-introduce later if a
  market needs it.

---

## v2.1 audit hardening (this pass) — landed

Beyond the sprints below (which are largely done), this pass added:

- **Worker fail-closed on unbound KV** (`worker/index.ts`): authenticated routes
  return 503 if `RATE_LIMITS` is missing in prod — supersedes the warn-only 7.4.
- **Geo build flag** `GEO_FAIL_OPEN` (prod fail-closed) + UI gating.
- **Binary-market filter** at cache entry (`isBinaryOutcomes`) — non-binary
  markets never reach the YES/NO trade flow.
- **Confirm step before signing** (spec §6.5) + **match context** (headline +
  confidence, spec §6.1) + **selectable alternates** (`onPickRelated`).
- **Build-integrity smoke** (`npm run smoke`) wired into CI; CI no-leak grep
  no longer self-matches its guard file; removed dead `Settings.locale`.

**Release-blocker status (updated 2026-06-23): the secret is rotated.** The
burned `770d0e45…` is gone from the build and `npm run preflight` passes. The
shared secret is baked into the client *by design* — it cannot be kept private
in a distributed extension; the real abuse backstop is the Worker's per-IP rate
limit + OpenAI cap, which fail closed (503) when `RATE_LIMITS` KV is unbound in
prod. CI is green on Node 24 / npm 11. The remaining gates to public launch are
**non-code**: a legal/geo review and the closed beta (Sprint 11).

---

## Sprint 6 — Trading correctness + order ticket 🔴 release blocker

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

Tests (TDD): `orderMath` (shares/payout/return, tick, maker/taker, FOK cap).

## Sprint 7 — Worker hardening 🔴 release blocker

| ID | Exact change | Files |
|---|---|---|
| 7.1 | `/embeddings` input validation: `texts` array; `len ≤ 64`; each `≤ 2000` chars; total `≤ 20000`; body `≤ 256KB` → 400/413 | `worker/index.ts` |
| 7.2 | OpenAI daily quota counted by chars (≈tokens), KV `openai_chars_day:<date>`, cap from env | `worker/index.ts` |
| 7.3 | `/telemetry` persist to Analytics Engine or D1 (not `console.log`); add binding | `worker/index.ts`, `worker/wrangler.toml(.example)` |
| 7.4 | `console.warn` once when `RATE_LIMITS` KV unbound (fail-open visibility) | `worker/index.ts` |

## Sprint 8 — Secrets, geo posture, build hygiene 🔴 release blocker (light)

| ID | Exact change | Files |
|---|---|---|
| 8.1 | Rotate `WORKER_SHARED_SECRET` (wrangler + `.env.local`); ensure `770d0e45…` gone; move secrets out of OneDrive sync | `.env.local`, CF |
| 8.2 | Rewrite spec §10/§5.3 + SECURITY.md to document geo fail-open | `actually-extension-spec.md`, `SECURITY.md` |
| 8.3 | Add telemetry `geo_unknown`; emit in `connectWallet`/`placeOrder` on unknown | `shared/types.ts`, `background/trade.ts` |
| 8.4 | Pin Node 20 (`engines.node`); README note on non-ASCII/OneDrive build paths | `package.json`, `README.md` |

## Sprint 9 — Tests & CI (finishes spec Sprint 6) 🟠

| ID | Exact change | Files |
|---|---|---|
| 9.1 | Miniflare worker tests: auth (401/503/dev), CORS fail-closed, `/geo` (US/CA-ON/RS/extra), rate-limit 429, `/history`, `/orderbook`, `/embeddings` limits | `worker/*.test.ts` (new), `package.json` |
| 9.2 | Component tests (RTL): CheckTab links, YES/NO map, ticket math, slippage>20% disable, analytics gated by wallet, Limit/Market toggle | `popup_new/*.test.tsx` (new) |
| 9.3 | `matcher.test.ts` imports real functions instead of copy-paste | `background/matcher.ts`, `matcher.test.ts` |

## Sprint 10 — Cleanup & honesty 🟡

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

## Sprint 11 — Beta + CWS (spec Sprint 7) ⚪

1. Prod build with rotated `.env.local`; verify dist CSP single origin + host_permissions = clob only.
2. Clean-Chrome smoke per updated `release-checklist.md` (discovery → connect → limit → market FOK → disconnect&wipe → telemetry off).
3. CWS assets: 3–5 screenshots, promo images, privacy URL, single-purpose + permission justifications.
4. Closed beta: 10–20 crypto-native + 10–20 normie; collect KPIs (computable after 7.3).
5. Sprint 12 = beta fixes → public launch (Product Hunt + CryptoTwitter).

## Post-v1 (parked)

- **v1.1:** bundle MiniLM-L12 weights into .crx → drop `huggingface.co` from CSP; closes npm-audit critical/high surface; offline-installable.
- **v1.2:** HMAC `X-Actually-Auth` (timestamp+nonce+body) + Worker `POST /clob/order` proxy → remove clob `host_permissions`; server-side geo re-check on submit.
- Full POLY_1271 / deposit-wallet support (if deferred from 6.9).
- Full EIP-55 checksum in `wallet.ts`.

## Critical path

Sprint 6 → 7 → 8 (blockers) → 9/10 (parallel) → 11. ≈ 7–9 working days.
