# Actually — Chrome Extension

> "What do markets really think?"
> A Chrome extension that shows Polymarket odds on any news page — and lets you trade them in one click if you connect a wallet.

Two audiences, one product:

- **Discovery (no wallet needed):** click the toolbar icon while reading a news article → see the matched market and its probability, color-coded. Click out to Polymarket if you want.
- **Trading (opt-in via WalletConnect):** connect MetaMask / Rabby / any WC-compatible wallet → unlocks the Trade tab with 7-day sparkline, orderbook spread, payout calculator, and one-signature order placement attributed to our builder code.

Spec: [`actually-extension-spec.md`](../actually-extension-spec.md) (v2.0)
Growth plan: [`actually-growth-strategy.md`](../actually-growth-strategy.md) (v2.0)
Privacy: [`docs/privacy-policy.md`](docs/privacy-policy.md)
Terms: [`docs/terms-of-service.md`](docs/terms-of-service.md)
Security triage: [`SECURITY.md`](SECURITY.md)

---

## Status

| Module | Status |
|--------|--------|
| Manifest V3, popup-only UX (offscreen doc for heavy ops) | ✅ |
| Local embeddings (`Xenova/all-MiniLM-L12-v2`, free) | ✅ |
| OpenAI fallback via Worker (server-side key) | ✅ |
| Diff-cache for market embeddings, lazy TTL refresh | ✅ |
| Cosine-similarity matcher + noise filter + low-confidence fallback | ✅ |
| History (local, 10 items, deduped) | ✅ |
| Anonymous telemetry (opt-out, 16 honest events, bounded queue) | ✅ |
| English-only UI (i18n layer removed in v1) | ✅ |
| Hotkey (Cmd/Ctrl+Shift+P) | ✅ |
| Cloudflare Worker proxy — fail-closed auth + rate limits | ✅ |
| **WalletConnect v2** integration | ✅ |
| **Polymarket CLOB v2** order placement with `builderCode` | ✅ |
| **Geo-fence** for trading via Worker `/geo` | ✅ |
| Trade analytics: sparkline / orderbook / resolution card | ✅ |
| Self-hosted Marck Script font (no remote fetch) | ✅ |
| Privacy policy + ToS | ✅ |
| Unit tests (vitest, 36 passing) | ✅ |

---

## Setup

### 1. Prereqs
- Node.js 20+ (pinned via `engines` in package.json; CI uses 20)
- A Cloudflare account (free tier is enough)
- A **WalletConnect Cloud project id** — get one free at https://cloud.walletconnect.com
- A **Polymarket builderCode** — see [Getting a builderCode](#getting-a-polymarket-buildercode)

### 2. Install deps
```bash
cd extension
npm install
cp .env.example .env.local
# Edit .env.local — set VITE_WC_PROJECT_ID, VITE_BUILDER_CODE,
#                       VITE_WORKER_URL, VITE_WORKER_SECRET
npm run fonts:fetch        # downloads Marck Script woff2 → public/fonts/
```

> **Reproducible builds.** Some setups (notably OneDrive-synced project paths
> with non-ASCII characters) intermittently break Vite's worker resolution
> with `Cannot read directory "../../../../.." Access is denied`. If you hit
> that, clone the repo into an ASCII-only path under `C:\src\` (Windows) or
> `~/src/` (mac/Linux) and build there.

### 3. Deploy the Worker
```bash
cd worker

# Create the KV namespace for rate limits; paste the returned id into wrangler.toml
npx wrangler kv:namespace create RATE_LIMITS

# Generate a strong shared secret (used by the extension to authenticate to your Worker)
openssl rand -hex 32 | npx wrangler secret put WORKER_SHARED_SECRET

# (Optional) Centralized OpenAI key, only if you offer the OpenAI embedding path
npx wrangler secret put OPENAI_API_KEY

# Deploy
npx wrangler deploy
# → copy the printed URL, e.g. https://actually-api.<you>.workers.dev
```

After your first dev install of the extension, copy its ID from `chrome://extensions` and:
```bash
npx wrangler secret put ALLOWED_EXTENSION_ID
# paste the extension id (no chrome-extension:// prefix)
```
The Worker fails closed (503) until both `WORKER_SHARED_SECRET` and `ALLOWED_EXTENSION_ID` are set — by design.

### 4. Build the extension
```bash
cd extension
npm run build
```

### 5. Load in Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/dist/`
4. Open the popup → **Settings** → paste your **Worker URL** and **Worker secret** (the `WORKER_SHARED_SECRET` value)
5. Open any news article → click the toolbar icon (or `Ctrl/Cmd+Shift+P`)
6. (Optional) Switch to the **Trade** tab → **Connect wallet** to enable order placement

---

## Getting a Polymarket builderCode

1. Go to https://polymarket.com → connect a wallet (MetaMask, Coinbase, etc.)
2. If you don't have one yet, deposit at least $1 USDC.e on Polygon — required for builder profile activation
3. Open `polymarket.com/settings` → **Builder** tab → **Create New**
4. Copy the resulting `builderCode` (a `0x…` 64-hex-char string)
5. Paste it into `.env.local` as `VITE_BUILDER_CODE`
6. Rebuild: `npm run build`

The builderCode is baked into the extension at build time and used by **every** order it submits. Polymarket attributes that order's volume to your builder profile on-chain. This is how the extension is monetized — see [`actually-growth-strategy.md`](../actually-growth-strategy.md) for KPI targets.

---

## Development

```bash
npm run dev              # Vite watch mode → outputs to dist/
npm run worker:dev       # Wrangler local dev for the API (uses WORKER_DEV_MODE)
npm test                 # Vitest unit tests (36 passing)
npm run lint             # tsc --noEmit type check
npm run fonts:fetch      # (re)download Marck Script woff2 → public/fonts/
```

When you change `manifest.json` or any service-worker file, reload the extension in `chrome://extensions`. Popup hot-reloads via Vite.

For matching iteration without rebuilding, use the offline scripts:
```bash
WORKER_URL=https://... WORKER_SECRET=... node scripts/test-match.mjs
```

---

## Architecture

Three-context model: popup (UI), service worker (router), offscreen document
(heavy ops). See [`actually-extension-spec.md` §3.5](../actually-extension-spec.md)
for the rationale.

```
extension/
├── manifest.json              MV3 — activeTab + scripting + alarms + offscreen
│                              + host_permissions: clob.polymarket.com (see spec §9.1)
├── vite.config.ts             Tightens connect-src to VITE_WORKER_URL at build time
├── src/
│   ├── background/
│   │   ├── index.ts           SW: install, alarms, message router → offscreen
│   │   ├── offscreen-host.ts  Lazy create + route OS_* messages
│   │   ├── extractor.ts       Headline + body — runs in page via scripting
│   │   ├── embeddings.ts      Local MiniLM-L12 + OpenAI fallback
│   │   ├── polymarket.ts      Gamma fetch + tickSize normalization
│   │   ├── cache.ts           Diff-cache by id + question hash
│   │   ├── matcher.ts         Cosine + noise filter + keyword-overlap bonus
│   │   ├── settings.ts        chrome.storage wrapper
│   │   ├── history.ts         Last-10 with URL dedup
│   │   ├── telemetry.ts       Anonymous event queue (1000-cap) + flush
│   │   ├── wallet.ts          WC v2 SignClient + WCSigner
│   │   ├── clob.ts            clob-client-v2 init + signBuy/submit/pollStatus
│   │   ├── trade.ts           connectWallet, placeOrder (with staged telemetry)
│   │   ├── geo.ts             Country check via Worker /geo
│   │   └── util.ts            sha256, float32↔b64, cosine, findOutcomeIndex,
│   │                          safeJsonArray, formatRelative, shortHash
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.ts       Heavy ops: match, refresh, connect, place_order
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.tsx           Mounts IntegratedPopup from popup_new
│   │   └── operations.ts      extractActiveTabArticle + live price
│   ├── popup_new/             The actual UI (glass design system)
│   │   ├── IntegratedPopup.tsx
│   │   ├── TradeTabWired.tsx
│   │   ├── ops.ts             Popup-side adapter for offscreen RPCs
│   │   ├── fonts.css          Single @font-face → Marck Script
│   │   ├── styles.css
│   │   ├── components/        Etched, GlassButton, IceCard, Tabs, …
│   │   ├── tabs/              CheckTab, HistoryTab, SettingsTab, TradeTab
│   │   └── trade/Analytics.tsx  Sparkline + Orderbook + ResolutionCard
│   ├── shared/
│   │   ├── types.ts           Settings, PolyMarket (+ tickSize), MatchResult
│   │   ├── constants.ts       Thresholds, BUILDER_CODE, model id, colors
│   │   └── messages.ts        Typed SW ↔ offscreen ↔ popup messages
├── worker/
│   ├── index.ts               /markets, /price, /orderbook, /history,
│   │                          /geo, /clob/proxy/<eoa>, /embeddings, /telemetry
│   ├── wrangler.toml          Placeholders only — never commit real ids
│   └── wrangler.toml.example  Step-by-step setup
├── public/
│   ├── icon-{16,48,128}.png
│   └── fonts/MarckScript-Regular.woff2   # from `npm run fonts:fetch`
├── scripts/                   Offline matching + fonts:fetch (env-driven)
└── docs/
    ├── privacy-policy.md
    └── terms-of-service.md
```

### Architecture decisions for v1

These deliberate deviations from a "pure" spec are documented in
[`actually-extension-spec.md`](../actually-extension-spec.md):

- **Direct CLOB order routing** instead of Worker `/clob/order` proxy
  (spec §9.1). Costs one `host_permissions` entry; saves the Worker leg.
- **No content script in v1.** Page reading goes via `chrome.scripting.executeScript`
  under `activeTab`. In-page widget deferred to v1.2.
- **Baked-in `WORKER_SHARED_SECRET`** treated as a client token (spec §13).
  Real defense is per-IP rate limit. HMAC-signed auth in v1.2.

---

## How a trade goes through

1. User opens a news article → clicks toolbar icon → **Check this page**
2. Popup extracts headline + body, embeds them locally, ranks against cached markets
3. Match card shows: question, YES %, color, link to Polymarket, "Trade this market →"
4. User clicks into Trade tab → **Connect wallet**
5. Popup calls Worker `/geo` — if restricted region, refuses; otherwise shows WC QR
6. User scans / approves in wallet → WC session established → EOA address known
7. Popup calls Worker `/clob/proxy/<eoa>` → resolves Polymarket Safe address (CREATE2)
8. `@polymarket/clob-client-v2` is initialized with `signatureType = POLY_GNOSIS_SAFE`, our `builderCode`, the user's Safe as funder
9. One-time signature: derive CLOB API key/secret/passphrase, persist to local storage
10. User picks side, enters USD size → payout preview updates → **Place order**
11. clob-client builds the EIP-712 order with our `builderCode` in the struct, asks WC to sign
12. Signed order POSTs to `clob.polymarket.com`. CLOB credits the volume to our builder profile.

Subsequent orders: skip steps 5-9 — the popup restores the WC session and CLOB credentials from storage, asks only for the per-order signature.

---

## Cost (per 5K MAU, monthly)

| Component | Cost |
|---|---|
| Local embeddings (default) | $0 |
| OpenAI text-embedding-3-small (opt-in path) | ~$3 |
| Cloudflare Workers + KV (free tier covers up to 100K req/day) | $0 |
| WalletConnect Cloud (free tier) | $0 |

---

## Roadmap

- **v1.0** — current. Discovery + WalletConnect trading + builder attribution. Goal: 500 installs by Week 6, $10k/week attributed volume by Week 12.
- **v1.1** — Order status polling, sell-to-close, position list, multi-market per page
- **v1.2** — Safari port
- **v1.3** — In-page widget (toggle), bigger cache, advanced order types

See [`actually-growth-strategy.md`](../actually-growth-strategy.md) for full KPI targets.

## License

TBD before public release.
