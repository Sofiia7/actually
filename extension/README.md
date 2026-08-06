# Actually — Chrome Extension

> "What do markets really think?"
> A Chrome extension that shows Polymarket odds on any news page — and lets you trade them in one click if you connect a wallet.

Two audiences, one product:

- **Discovery (no wallet needed):** click the toolbar icon while reading a news article → see the matched market and its probability, color-coded. Click out to Polymarket if you want.
- **Trading (opt-in via WalletConnect):** connect MetaMask / Rabby / any WC-compatible wallet → unlocks the Trade tab with 7-day sparkline, orderbook spread, payout calculator, and one-signature order placement attributed to our builder code.

Spec: [`actually-extension-spec.md`](../actually-extension-spec.md) (v2.1)
Growth plan: [`actually-growth-strategy.md`](../actually-growth-strategy.md) (v2.0)
Privacy: [`docs/privacy-policy.md`](docs/privacy-policy.md)
Terms: [`docs/terms-of-service.md`](docs/terms-of-service.md)
Security triage: [`SECURITY.md`](SECURITY.md)

**Verify it's real in 60 seconds** — no wallet, worker, or secret needed:

```bash
cd extension && npm install && npm test   # 137 unit + component tests, all green
```

What the extension actually does is walked through in [How matching works](#how-matching-works); full setup is below.

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
| Pseudonymous telemetry (opt-in, 19 honest events, bounded queue) | ✅ |
| English-only UI (i18n layer removed in v1) | ✅ |
| Hotkey (Cmd/Ctrl+Shift+P) | ✅ |
| Cloudflare Worker proxy — fail-closed auth + rate limits | ✅ |
| **WalletConnect v2** integration | ✅ |
| **Polymarket CLOB v2** order placement with `builderCode` | ✅ |
| **Geo-fence** for trading via Worker `/geo` | ✅ |
| Trade analytics: sparkline / orderbook / resolution card | ✅ |
| Open positions panel with cost basis + unrealized P&L | ✅ |
| Resting-order list with in-app cancel (no polymarket.com round-trip) | ✅ |
| Order-book depth beyond best bid/ask | ✅ |
| Self-hosted Marck Script font (no remote fetch) | ✅ |
| Privacy policy + ToS | ✅ |
| Unit + component tests (vitest, 137 passing) | ✅ |
| Build-integrity smoke gate (`npm run smoke`) | ✅ |

---

## How matching works

No server-side model and no per-request inference cost: the article is embedded
**in your browser**. The default path never sends page content anywhere.

```
 news article (any page)
        │  chrome.scripting (activeTab) — extractor.ts
        ▼
 headline ×HEADLINE_WEIGHT  +  trimmed body
        │  offscreen document (MV3) — WASM
        ▼
 Xenova/all-MiniLM-L12-v2  →  384-d vector  (mean-pooled, L2-normalized)
        │
        ▼                          market cache (diff-cached, pre-embedded)
 cosine similarity  ───────────────── vs every cached market vector
        │
        ├─ + lexical-overlap bonus  (shared keyword stems; generic country /
        │     leader / econ stems down-weighted via LOW_VALUE_OVERLAP)
        ├─ + tiny volume bonus      (tiebreaker only, capped)
        ▼
 rank → top match + up to 4 alternatives
        │  threshold on RAW cosine (confidenceThreshold / lowConfidenceFloor)
        ▼
 Check tab:  question · YES % · color      Trade tab (wallet):
                                           WalletConnect → CLOB order (builderCode)
```

Three design choices that aren't obvious from "just use embeddings":

- **Local-first model.** `Xenova/all-MiniLM-L12-v2` (384-dim) runs as WASM inside
  an MV3 *offscreen document* — service workers can't run it directly, so
  transformers.js globals are polyfilled and ONNX is forced single-thread. The
  ~33 MB model weights + WASM runtime are bundled into the extension package at
  build time (`npm run models:fetch`) — no first-run download, no HuggingFace/CDN
  fetch at install or runtime; matches run in ~100 ms from the first use. An
  OpenAI `text-embedding-3-small` path exists as an opt-in fallback via the Worker.
- **Lexical overlap on top of cosine.** Pure cosine treats every "Iran"-mentioning
  market as equally close; a `+0.04`-per-shared-keyword-stem bonus (capped `0.15`)
  lets the *specific* noun win — e.g. "uranium" over a generic "Iran" market.
  Generic stems (countries, leader names, "price", "year") are down-weighted to
  `+0.01` so thematic generality can't dominate a sharper semantic match.
- **Confidence is measured on the raw semantic score**, not the boosted one — the
  volume and keyword bonuses only break ties and re-rank; they never inflate the
  confidence shown to the user or push a weak match past the floor.

Market embeddings are precomputed and **diff-cached** by id + question-hash, so a
match is one local embed + N cosine ops, not N model calls.

---

## Setup

### 1. Prereqs
- Node.js 20+ to run. **Reproducible installs need Node 24 / npm 11** — the committed `package-lock.json` is npm 11, and older npm rejects it on `npm ci`. Version pinned via [`.nvmrc`](.nvmrc); CI runs Node 24.
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

> **Durable Objects require the Workers Paid plan** ($5/mo), not the Free
> plan. Rate limiting + the OpenAI daily cap are backed by a Durable Object
> (`RATE_LIMITER_DO`, see `worker/index.ts`) for atomicity — check your
> Cloudflare account tier before deploying, or `wrangler deploy` will fail on
> the `[[durable_objects.bindings]]` / `[[migrations]]` entries in
> `wrangler.toml`.

```bash
cd worker

# Generate a strong shared secret (used by the extension to authenticate to your Worker)
openssl rand -hex 32 | npx wrangler secret put WORKER_SHARED_SECRET

# (Optional) Centralized OpenAI key, only if you offer the OpenAI embedding path
npx wrangler secret put OPENAI_API_KEY

# Deploy — this also creates the RATE_LIMITER_DO Durable Object namespace via
# the [[migrations]] block in wrangler.toml, no separate creation step needed.
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
npm test                 # Vitest unit + component tests (137 passing)
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
│   │   ├── telemetry.ts       Pseudonymous event queue (1000-cap) + flush, opt-in
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
│   └── fonts/MarckScript-Regular-{latin,latin-ext,cyrillic}.woff2   # from `npm run fonts:fetch` (one file per subset — shipping only one was the 2026-08-02 Comic-Sans-fallback bug)
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
  Real defense is per-IP rate limit, atomically enforced by a Durable Object
  (the Worker fails closed — 503 — if `RATE_LIMITER_DO` is unbound in prod).
  HMAC-signed auth in v1.2.
- **Geo posture is build-flagged.** Production builds fail *closed* when the
  region can't be confirmed; dev/beta builds fail open. Confirmed-restricted
  countries are always blocked. See `GEO_FAIL_OPEN` in `src/shared/constants.ts`
  and `SECURITY.md`.
- **Existing Polymarket Safe wallets only (v1).** Orders sign with
  `signatureType = POLY_GNOSIS_SAFE`. Fresh deposit wallets (`POLY_1271`) are
  post-v1; the Connect panel says so up front.

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
- **Post-v1 (engineering status, canonical)** — see [`docs/ROADMAP.md`](docs/ROADMAP.md) for
  what's actually shipped vs. parked, verified against code (bundled embedding model: shipped;
  HMAC-signed Worker auth + `/clob/order` proxy, full POLY_1271 support, full EIP-55 checksum:
  parked). That document is the source of truth for version labels — don't infer status from
  numbers in this section, since this list and ROADMAP.md's have drifted before.
- **Post-v1 (product backlog, not yet started, not version-numbered)** — sell-to-close (closing a
  filled position from the extension UI; resting *orders* can already be cancelled, and positions/
  order status are already visible — see the Status table above), multi-market per page, Safari
  port, in-page widget (toggle), bigger cache, advanced order types.

See [`actually-growth-strategy.md`](../actually-growth-strategy.md) for full KPI targets.

## About this build

Actually was conceived, designed, and directed by **Sofiia Velichkovskaia** ([@Sofiia7](https://github.com/Sofiia7)).
The product idea — news → prediction-market odds → one-click trade — the visual and
UX design (the glass design system, the two-audience flow), and the engineering
direction are hers. That direction includes the security and correctness audit that
shaped v2.1: the fail-closed Worker posture, the build-flagged geo gate, the
binary-market filter, the confirm-before-sign step, and the release gates
(`npm run preflight` + `npm run smoke`).

Implementation was done with heavy AI assistance (Claude) acting as a pair-programmer
under her review — turning each audit finding and design decision into code, tests,
and docs. Every change was gated by her acceptance criteria and by the test suite
(137 passing here; 365 across the whole monorepo, including the `@actually/core` and
`actually-mcp-server` workspaces) + CI before it landed.

In short: the *what* and the *why* — product, design, decisions, audit — are Sofiia's;
the AI accelerated the *how*.

## License

Released under the [MIT License](../LICENSE) — © 2026 Sofiia Velichkovskaia.
