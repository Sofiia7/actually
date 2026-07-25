# Release checklist — Actually v1.0.0

A practical step-by-step covering the gap between "code merged" and "live on
Chrome Web Store". Don't skip steps unless you've checked the corresponding
risk.

---

## Pre-flight

- [ ] `npm run fonts:fetch` on a clean checkout (run on the build machine,
      not assumed from prior runs).
- [ ] `npm run models:fetch` on a clean checkout — populates `public/models/`
      (~34MB ONNX weights) and `public/onnx/` (WASM runtime), both gitignored.
      Without this the build still succeeds but the shipped extension's local
      embedder has no model to load (remote fallback is intentionally
      disabled — see `SECURITY.md`).
- [ ] `npm ci && npm run lint && npm test` all green.
- [ ] `npm run build` with **production** `.env.local`:
  - `VITE_BUILDER_CODE` is your real bytes32 from polymarket.com builder
        settings.
  - `VITE_WC_PROJECT_ID` is the real WalletConnect Cloud project id.
  - `VITE_WORKER_URL` is the production Worker URL.
  - `VITE_WORKER_SECRET` is the **rotated** secret (see below).
- [ ] `grep 'connect-src' dist/manifest.json` — confirm exactly one
      `https://<account>.workers.dev` origin, no wildcard.
- [ ] `grep 'host_permissions' dist/manifest.json` — exactly
      `["https://clob.polymarket.com/*"]`.
- [ ] `npm run preflight` — automated gate: CSP has no `*.workers.dev`,
      host_permissions = clob only, no burned secret in dist, version present.
      See also `docs/cws-listing.md` for ready-to-paste store copy.
- [ ] `npm run smoke` on this same production `dist/` — automated gate that
      `preflight` does **not** cover: confirms the ~34MB embedding model and
      ONNX WASM runtime actually got bundled (catches a build run without
      `npm run models:fetch`), plus that the service worker/popup/offscreen
      HTML and icons are present. Run this before the manual click-through
      below, not instead of it — smoke checks file presence, not behavior.
- [ ] Smoke-load `dist/` as an unpacked extension in a clean Chrome profile
      and walk through the **manual smoke** below.

## Do not strip `manifest.json`'s `key` field

`extension/manifest.json` carries a `key` (RSA public key) that deliberately
reserves a stable Chrome extension ID — computed once so the ID the Chrome
Web Store assigns on this item's first-ever publish matches
`ALLOWED_EXTENSION_ID` in `worker/wrangler.toml` (already `lljnfdfoieiodiiaglimlfjlebljdmhb`,
verified 2026-07-07 by hashing the key: `sha256(key)[0:16]` mapped a–p equals
that ID). Removing `key` before upload would forfeit the reservation — CWS
would assign a random new ID instead, and the Worker would 401 every
store-installed user until someone notices and updates the allowlist.
`npm run preflight` now verifies the key still resolves to that ID.

**After the first successful publish**, add the CWS-assigned ID to
`ALLOWED_EXTENSION_ID` as a second comma-separated entry if it ever differs
(e.g. `lljnfd...,newid...`), verified against a real install from the store —
don't assume the reservation held without checking.

## Worker secret — NOT a release step

`WORKER_SHARED_SECRET` was rotated 2026-06-23 and does not need rotating
again for this or future releases. It is public by design — baked into the
extension bundle, extractable by anyone who unpacks the `.crx` — so it
provides no confidentiality; it only filters out casual/accidental traffic.
The actual abuse defense is the Worker's per-IP `RateLimiterDO` Durable
Object rate limiting plus the OpenAI daily spend cap, not secrecy of this
value. Only rotate it if you specifically need to cut off a previously
shipped build from the Worker (e.g. a burned/compromised extension build) —
that's a deliberate, standalone action, not something to do routinely before
every ship:

```powershell
cd extension/worker
$NEW = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
$NEW | npx wrangler secret put WORKER_SHARED_SECRET
# extension/.env.local → VITE_WORKER_SECRET=<NEW>, then npm run build
```

## Manual smoke (clean Chrome profile, after fresh build)

| Step | Expected |
|---|---|
| Install unpacked from `dist/` | Permission prompt = "Read your browsing history". Nothing else. |
| Open any news article, click toolbar icon | Popup opens. Marck Script renders (not system cursive). |
| Click **Check this page** | First match card after ~3–10 s. YES % + volume + match %. |
| Click "View on Polymarket →" | Opens the matched market URL in a new tab. URL contains `utm_source=actually`. |
| Click "Trade this market →" | Switches to Trade tab. Featured market card already populated. |
| Trade tab without wallet | Odds card + Connect-wallet panel only — analytics (sparkline/orderbook/resolution) are wallet-gated and must NOT render here. |
| Click **Connect wallet** | QR + "Open in wallet" deeplink appear. |
| Approve in mobile MetaMask | Order form appears. EOA + Safe addresses visible in Settings → Wallet. |
| Toggle BUY YES / BUY NO | Best bid/ask + maker/taker badge update per side; limit price prefills to the side's best ask. |
| Toggle Limit / Market | Limit shows an editable price field; Market shows the FOK cap (~2%) and a depth-based est. fill + slippage. |
| Enter $1 size, Limit order, submit | Wallet prompts for typed-data sig. GTC order ID returned. Polymarket shows it under our builder profile. |
| Enter $1 size, Market order, submit | FOK fill (or clean reject if depth is thin / slippage > 20%). |
| Orderbook depth panel | Shows levels beyond best bid/ask (not just top-of-book) for the active side's token. |
| After the Limit order above, reopen Trade tab | Open Positions/Orders panel shows the new resting order with market/outcome identity, not just a bare price/size row. |
| Click **Cancel** on that resting order | Order disappears from the panel; a genuine CLOB rejection (e.g. already filled) surfaces as visible error text, not a silent no-op. |
| Settings → Wallet → **Disconnect & wipe** | EOA / Safe / creds gone from storage. Trade tab returns to Connect panel. |
| Disable telemetry in Settings | `chrome.storage.local.get('telemetryQueue')` stays unchanged on next match. |

## CWS submission

- [ ] `npm run build` with the production `.env.local`.
- [ ] `cd dist && zip -r ../actually-v1.0.0.zip .` — single artifact for upload.
- [ ] Chrome Web Store Developer Dashboard → new item → upload zip.
- [ ] Listing fields:
  - **Title:** Actually — What Markets Really Think
  - **Summary (132 chars):** Click any news story to see what prediction
        markets really think. Optional one-click trading via WalletConnect.
  - **Detailed description:** lift from `docs/cws-listing.md` (the canonical,
        code-verified copy) — not `README.md`, which is written for
        developers and drifts from the store-facing wording.
  - **Category:** Productivity (primary).
  - **Privacy practices** form: use `docs/cws-listing.md`'s "Data-use /
        privacy form answers" section VERBATIM — do not re-derive these here.
        In short: **"Website content" → Yes** (opt-in OpenAI embedding path
        only) and **"User activity" → Yes** (opt-in telemetry) — leaving
        either at "No" is a real compliance risk, not a formality; see that
        file for the full reasoning and the other categories (all "No").
    - Justify `activeTab` and `scripting`: "read the headline + first 500
      chars of the active tab on user click, to find a matching market".
    - Justify `host_permissions: clob.polymarket.com`: "send signed orders
      to Polymarket's order book on user click".
    - Justify `alarms`: "schedule market-cache refresh every 30 min".
    - Justify `offscreen`: "host transformers.js embedding pipeline and
      WalletConnect v2 SignClient (MV3 service workers cannot)".
- [ ] **Screenshots** — use `docs/cws-listing.md`'s shot list verbatim (kept
      in sync there, not duplicated here).
- [ ] **Promotional images** (440×280, 920×680, 1400×560):
  - 440×280 is the small tile — text overlay must be readable at thumbnail.
  - 1400×560 is the marquee — use the matched-market screenshot, cropped.
- [ ] **Privacy policy URL:** point at the hosted `docs/privacy-policy.md`
      (GitHub Pages or your domain).
- [ ] **Single-purpose justification** (CWS asks): "Show users what
      prediction markets are saying about news they're reading, and let
      them optionally trade on those markets in one click."
- [ ] Submit. CWS review typically takes 1–7 days.

## Closed beta — recommended structure

Don't open-launch. Burn ~2 weeks on a small cohort to catch the things only
real users see.

### Crypto-native cohort (target n=10–20)
- Channels: CryptoTwitter DMs to known Polymarket traders, r/CryptoCurrency
  invite thread (mod-approved), Polymarket Discord beta channel.
- Briefing: send them the `dist/` zip + `actually-v1.0.0-beta.crx`, plus
  this checklist's "Manual smoke" section.
- Ask: `wallet_connect_success_rate`, `order_submitted_per_WAU`,
  `builder_attributed_volume` over a week. The builder dashboard is the
  ground truth.

### Normie cohort (target n=10–20)
- Channels: friends, journalists, market-watchers who *read* news rather
  than trade. People who have never touched a wallet.
- Ask: install → first `Check this page` time; what fraction click
  "View on Polymarket"; would they recommend (NPS-style 1-question).
- Watch for: any wallet UI showing up where it shouldn't, any confusion
  about what the percentage means.

### After beta
- Iterate one cycle (Sprint 8 ≈ "beta findings + bugfix").
- Then open CWS launch + Product Hunt + CryptoTwitter coordinated post.

## Post-launch operations

- Monitor abuse via the `RATE_LIMITER_DO` Durable Object (rate limiting and
  the OpenAI daily cap both live there now — the old `openai_day:*`/`rl:*` KV
  counters this checklist used to reference were replaced by the DO and no
  longer exist; use `wrangler tail` / the Workers dashboard for DO-backed
  observability instead).
- Watch builder dashboard for attributed volume.
- Do **not** rotate `WORKER_SHARED_SECRET` on a schedule — see "Worker secret
  — NOT a release step" above.
- When `@polymarket/clob-client-v2` ships ethers v6 support, rebuild and
  re-run `npm audit` triage.
