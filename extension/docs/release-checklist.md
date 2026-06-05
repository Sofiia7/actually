# Release checklist — Actually v1.0.0

A practical step-by-step covering the gap between "code merged" and "live on
Chrome Web Store". Don't skip steps unless you've checked the corresponding
risk.

---

## Pre-flight

- [ ] `npm run fonts:fetch` on a clean checkout (run on the build machine,
      not assumed from prior runs).
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
- [ ] Smoke-load `dist/` as an unpacked extension in a clean Chrome profile
      and walk through the **manual smoke** below.

## Rotate the Worker secret before shipping

The v2.0 secret (`770d0e45…2e1f6b`) was once committed to
`scripts/probe.mjs`. Treat it as public forever.

```powershell
cd extension/worker
$NEW = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
$NEW | npx wrangler secret put WORKER_SHARED_SECRET
# Save $NEW into 1Password / your secret store, then:
# extension/.env.local → VITE_WORKER_SECRET=<NEW>
# npm run build
```

After the new secret is live, optionally add the old token to a blacklist in
`worker/index.ts` for 30 days so a leaked-client-secret detector fires.

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
  - **Detailed description:** lift from `README.md` top section.
  - **Category:** Productivity (primary).
  - **Privacy practices** form:
    - "I collect website content" → No (only on click, only the active tab).
    - "I use remote code" → No (no eval, no remote scripts; the embedding
      model is data, not executable code — but if the reviewer flags
      `huggingface.co`, point them to `SECURITY.md` and the planned bundle
      in v1.1).
    - Justify `activeTab` and `scripting`: "read the headline + first 500
      chars of the active tab on user click, to find a matching market".
    - Justify `host_permissions: clob.polymarket.com`: "send signed orders
      to Polymarket's order book on user click".
    - Justify `alarms`: "schedule market-cache refresh every 30 min".
    - Justify `offscreen`: "host transformers.js embedding pipeline and
      WalletConnect v2 SignClient (MV3 service workers cannot)".
- [ ] **Screenshots** (1280×800 PNG, at least 3):
  1. Popup over a real news article, idle Check tab.
  2. Match result with sparkline + orderbook visible.
  3. Order form with payout preview + slippage row.
  4. (optional) History tab populated.
  5. (optional) Settings → Wallet showing connected EOA + Disconnect & wipe.
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

- Monitor Cloudflare KV `openai_day:*` and `rl:*` counters for abuse.
- Watch builder dashboard for attributed volume.
- Rotate `WORKER_SHARED_SECRET` quarterly even without incident.
- When `@polymarket/clob-client-v2` ships ethers v6 support, rebuild and
  re-run `npm audit` triage.
