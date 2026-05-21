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
| Manifest V3, popup-only UX | ✅ |
| Local embeddings (`Xenova/all-MiniLM-L12-v2`, free) | ✅ |
| OpenAI fallback via Worker (server-side key) | ✅ |
| Diff-cache for market embeddings, lazy TTL refresh | ✅ |
| Cosine-similarity matcher + noise filter + low-confidence fallback | ✅ |
| History (local, 10 items, deduped) | ✅ |
| Anonymous telemetry (opt-out, 16 honest events) | ✅ |
| i18n (en, es, pt-BR) | ✅ |
| Hotkey (Cmd/Ctrl+Shift+P) | ✅ |
| Cloudflare Worker proxy — fail-closed auth + rate limits | ✅ |
| **WalletConnect v2** integration | ✅ |
| **Polymarket CLOB v2** order placement with `builderCode` | ✅ |
| **Geo-fence** for trading via Worker `/geo` | ✅ |
| Privacy policy + ToS | ✅ |
| Unit tests (vitest, 20 passing) | ✅ |

---

## Setup

### 1. Prereqs
- Node.js 18+
- A Cloudflare account (free tier is enough)
- A **WalletConnect Cloud project id** — get one free at https://cloud.walletconnect.com
- A **Polymarket builderCode** — see [Getting a builderCode](#getting-a-polymarket-buildercode)

### 2. Install deps
```bash
cd extension
npm install
cp .env.example .env.local
# Edit .env.local — set VITE_WC_PROJECT_ID and VITE_BUILDER_CODE
```

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
npm test                 # Vitest unit tests (20 passing)
npm run lint             # tsc --noEmit type check
```

When you change `manifest.json` or any service-worker file, reload the extension in `chrome://extensions`. Popup hot-reloads via Vite.

For matching iteration without rebuilding, use the offline scripts:
```bash
WORKER_URL=https://... WORKER_SECRET=... node scripts/test-match.mjs
```

---

## Architecture

```
extension/
├── manifest.json              Manifest V3 — activeTab + scripting + alarms
│                              + host_permissions: clob.polymarket.com
├── src/
│   ├── background/
│   │   ├── index.ts           Service Worker — install, alarms, message handlers
│   │   ├── extractor.ts       Headline + body extraction (runs in page context)
│   │   ├── embeddings.ts      Local (transformers.js MiniLM-L12) + OpenAI providers
│   │   ├── polymarket.ts      Gamma + live price client (via Worker)
│   │   ├── cache.ts           Diff-cache by market.id + question hash, TTL
│   │   ├── matcher.ts         Cosine similarity + noise filter + volume tiebreak
│   │   ├── settings.ts        Settings get/save with defaults
│   │   ├── history.ts         Last-10 with URL dedup
│   │   ├── telemetry.ts       Anonymous event queue + flush
│   │   ├── wallet.ts          WalletConnect v2 session, WCSigner for clob-client
│   │   ├── clob.ts            @polymarket/clob-client-v2 init + builderCode wiring
│   │   ├── trade.ts           Orchestrator: connect → derive creds → submit order
│   │   ├── geo.ts             Country check via Worker /geo
│   │   └── util.ts            sha256, float32<->b64, cosine, uuid
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx            Tab router (Check / Trade / History / Settings)
│   │   ├── CheckPage.tsx      Discovery — matched market, color, link out
│   │   ├── TradePanel.tsx     Trade — analytics + connect + order form
│   │   ├── trade/
│   │   │   ├── ConnectButton.tsx   WC v2 QR + deeplink
│   │   │   ├── OrderForm.tsx       Side + size + submit
│   │   │   ├── Sparkline.tsx       7d SVG sparkline
│   │   │   ├── Orderbook.tsx       Best bid / ask / spread
│   │   │   ├── PayoutPreview.tsx   Max payout, return %, slippage
│   │   │   ├── ResolutionCard.tsx  Resolution date, source, rules
│   │   │   └── GeoBlock.tsx
│   │   ├── History.tsx
│   │   ├── Settings.tsx
│   │   └── styles.css         Light, Polymarket-leaning theme
│   ├── shared/
│   │   ├── types.ts
│   │   ├── constants.ts       Thresholds, BUILDER_CODE, model id, colors
│   │   └── messages.ts        Typed SW <-> popup messages
│   └── i18n/
│       ├── index.ts
│       ├── en.json
│       ├── es.json
│       └── pt-BR.json
├── worker/
│   ├── index.ts               Cloudflare Worker:
│   │                            /markets, /price, /orderbook, /history,
│   │                            /geo, /clob/proxy/<eoa>, /embeddings, /telemetry
│   └── wrangler.toml
├── scripts/                   Offline matching tests (read WORKER_URL/SECRET from env)
└── docs/
    ├── privacy-policy.md
    └── terms-of-service.md
```

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
