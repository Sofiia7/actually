# ACTUALLY — Chrome Extension
## Technical Spec v2.0
**Version:** 2.0 | **Date:** May 2026
**Supersedes:** v1.0 Final (March 22, 2026) — see git history for previous version.

> v2.0 reflects the post-audit pivot:
> - Audience expanded to dual-mode (normie discovery + crypto-native trading)
> - Trading layer added (WalletConnect v2 + Polymarket CLOB v2 + builderCode)
> - Glassmorphism in-page widget cut (never shipped, popup-only UX retained)
> - Local embedding model is `Xenova/all-MiniLM-L12-v2` (384-dim)

---

## 1. PRODUCT SUMMARY

**Name:** Actually
**Tagline:** "What do markets really think?"
**Format:** Chrome Extension (Manifest V3)
**Distribution:** Chrome Web Store, free.

**Core mechanic:** User clicks the Actually icon while reading any news page → extension extracts headline + body → matches against cached Polymarket markets → shows odds card. If user has connected a wallet, a Trade tab unlocks with full analytics and one-click order placement attributed to our `builderCode`.

**Two equal-priority audiences:**

| Audience | What they get | Acquisition channel |
|---|---|---|
| **Normies** — news readers, no wallet, do not trade | Discovery: real market odds, color-coded confidence, link to Polymarket. Entire UX works without ever connecting a wallet. | Product Hunt, Reddit r/news/r/politics, newsletters, organic |
| **Crypto-native** — existing Polymarket traders | Same discovery + connected-wallet Trade tab: 7d sparkline, orderbook spread, payout/slippage calculator, resolution rules, builderCode-attributed order placement | Crypto Twitter, r/CryptoCurrency, r/ethfinance, Polymarket Discord |

The product **does not gate discovery behind wallet**. The product **does not push wallet** to users who don't ask for it. The two flows live in the same popup, separated by a tab.

**Why dual:** discovery has zero marginal cost and brings reach + installs (vanity + future user pool). Trading flow is where attributed volume → builder rewards happen. Cutting either path would either lose distribution or lose monetization.

---

## 2. ARCHITECTURE OVERVIEW

```
┌───────────────────────────────────────────────────────────────┐
│  Chrome Extension (popup, no content script in v1)           │
│                                                                │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐    │
│  │ Discover    │  │ Trade         │  │ Settings/History │    │
│  │ (default)   │  │ (wallet req)  │  │                  │    │
│  └──────┬──────┘  └──────┬────────┘  └──────────────────┘    │
│         │                │                                    │
│         ▼                ▼                                    │
│  ┌────────────────────────────────────────────────────┐      │
│  │  popup runtime: matcher, embeddings, cache, signer │      │
│  └─────────────────────────┬──────────────────────────┘      │
└────────────────────────────┼──────────────────────────────────┘
                             │ HTTPS + X-Actually-Auth
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (actually-api)                             │
│  /markets   Gamma proxy + cache                               │
│  /price     CLOB price proxy                                  │
│  /orderbook CLOB orderbook proxy (NEW)                        │
│  /history   Gamma price-history proxy (NEW)                   │
│  /geo       client geo check via CF headers (NEW)             │
│  /clob/*    CLOB API proxy for order submission (NEW)         │
│  /telemetry anonymous event ingest                            │
└───────────────────────────────────────────────────────────────┘
                             │
                             ▼
                    Polymarket Gamma + CLOB APIs
```

**Service worker role:** lightweight only. Lifecycle hooks, telemetry alarm, settings storage proxy. **All heavy work** (transformers.js embedding, market caching, matching, signing) happens in the popup context — MV3 service workers are too constrained for it.

**Worker role:** thin authenticated proxy. Adds per-IP rate limits, hides any future server-side secrets (none currently for read endpoints), enforces extension-origin CORS. The Worker does **not** sign orders — the user's wallet does.

---

## 3. FILE STRUCTURE (current + planned additions)

```
extension/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .env.example
├── .gitignore
├── README.md
├── docs/
│
├── src/
│   ├── background/
│   │   ├── index.ts          # SW: install, alarms, messages
│   │   ├── cache.ts          # market cache + TTL refresh           ← TTL TO BE WIRED
│   │   ├── embeddings.ts     # local (MiniLM-L12) + OpenAI provider
│   │   ├── extractor.ts      # headline + body extraction from page
│   │   ├── matcher.ts        # cosine-sim ranking + noise filters
│   │   ├── polymarket.ts     # Gamma + CLOB + builderUrl helpers
│   │   ├── history.ts        # last 10 matches
│   │   ├── settings.ts       # chrome.storage wrapper
│   │   ├── telemetry.ts      # event queue + flush
│   │   ├── trade.ts          # NEW: order construction, builderCode
│   │   ├── wallet.ts         # NEW: WalletConnect v2 wrapper
│   │   ├── clob.ts           # NEW: @polymarket/clob-client-v2 init
│   │   └── geo.ts            # NEW: geo check + blocklist
│   │
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx           # tab router: Discover / Trade / Settings / History
│   │   ├── CheckPage.tsx     # Discover tab (current main UI)
│   │   ├── TradePanel.tsx    # Trade tab — currently stub, becomes real
│   │   ├── Settings.tsx
│   │   ├── History.tsx
│   │   ├── operations.ts     # message senders to SW
│   │   ├── styles.css
│   │   └── trade/                                          ← NEW SUBFOLDER
│   │       ├── ConnectButton.tsx     # WC v2 connect/disconnect
│   │       ├── OrderForm.tsx         # size, side, price preview
│   │       ├── PayoutPreview.tsx     # max payout, return %, slippage
│   │       ├── Sparkline.tsx         # 7d price history
│   │       ├── Orderbook.tsx         # best bid/ask + spread
│   │       ├── ResolutionCard.tsx    # date, source, rules excerpt
│   │       └── GeoBlock.tsx          # disclaimer for restricted regions
│   │
│   ├── shared/
│   │   ├── constants.ts      # thresholds, colors, model id, geo list
│   │   ├── messages.ts       # SW <-> popup message types
│   │   └── types.ts          # Settings, PolyMarket, MatchResult, Order
│   │
│   └── i18n/
│       ├── index.ts
│       ├── en.json
│       ├── es.json
│       └── pt-BR.json
│
├── public/                   # icons
├── scripts/                  # offline matching test scripts
└── worker/
    ├── wrangler.toml
    ├── wrangler.toml.example                             ← NEW
    └── index.ts
```

---

## 4. MANIFEST V3

```jsonc
{
  "manifest_version": 3,
  "name": "Actually — What Markets Really Think",
  "version": "1.0.0",
  "description": "Click to see real market odds on any news story. Trade in one click if you want.",

  "permissions": ["storage", "activeTab", "alarms", "scripting"],
  "optional_permissions": [],
  "host_permissions": [],
  // REMOVED: optional_host_permissions ["https://*/*"] — not used, hurts review

  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },

  "action": {
    "default_popup": "src/popup/index.html",
    "default_icon": { "16": "...", "48": "...", "128": "..." }
  },

  "commands": {
    "_execute_action": {
      "suggested_key": { "default": "Ctrl+Shift+P", "mac": "Command+Shift+P" }
    }
  },

  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://* wss://*"
  }
}
```

**Notes:**
- `connect-src` must allow `https://*` and `wss://*` for WalletConnect (which talks to a relay over WSS) and CLOB submission.
- Still no content scripts → user trust prompt stays small ("Read data of active tab" only).
- The user must explicitly opt into trading by clicking "Connect wallet" — this triggers `chrome.permissions.request` only if we later add anything sensitive (likely not needed for WalletConnect v2 since it's pure HTTPS+WSS).

---

## 5. USER FLOWS

### 5.1 Normie flow (no wallet)

1. Install from Chrome Web Store
2. First open of popup: brief tooltip "Click the button to check this page". No wallet prompt.
3. Click "Check this page" → popup runs:
   - extract headline + first 500 chars from active tab via `chrome.scripting.executeScript`
   - if cache empty/stale, fetch markets from Worker `/markets` (with progress UI)
   - embed article + market questions (local MiniLM-L12)
   - rank by cosine similarity, apply noise filters, re-rank by volume tiebreaker
   - show odds card with: question, YES %, color (blue/yellow/red), volume, "Open on Polymarket" link with `?utm_source=actually`
4. Optional: "Trade this market" button in card → opens Trade tab → "Connect wallet to trade"
5. Normie ignores it and continues reading.

### 5.2 Crypto-native flow (with wallet)

1. Same install + first match as above
2. User clicks "Trade this market" or directly Trade tab → "Connect wallet"
3. WalletConnect v2 modal: choose wallet → scan QR or approve in mobile MetaMask / sign in browser MetaMask via injected provider on a connector page (see §8)
4. After connect: extension derives Safe address (CREATE2), calls `clobClient.createOrDeriveApiKey()` (one-time signature), stores credentials in `chrome.storage.local`
5. Trade tab renders full analytics (see §6) for the current matched market
6. User chooses side (YES/NO), size in USD, sees payout preview + slippage
7. Click "Place order" → MetaMask popup with EIP-712 typed data → user signs
8. Order goes to Worker `/clob/order` (proxy) → CLOB with our `builderCode` in struct
9. Card shows order id, status, "View on Polymarket" deeplink
10. Order appears in History tab with attribution status

### 5.3 Geo-restricted flow

Before any trading UI renders, the popup calls Worker `/geo` (CF returns `CF-IPCountry`). If country in blocklist (US, UK, FR, BE, AU, SG, TH, TW, PL, others — see §10), Trade tab renders `<GeoBlock>` instead of OrderForm. Discovery tab works normally — info is not geo-gated.

---

## 6. TRADE VIEW — analytics spec

When wallet is connected and market is selected, Trade tab shows the following blocks **in this order**:

### 6.1 Match context (always visible)
- Article headline (truncated)
- Matched market question
- Match confidence % with one-line explainer ("Article discusses X. Market predicts X by DATE.")
- Top-3 alternate matches expandable section (in case user disagrees with #1)

### 6.2 Market analytics
- **Sparkline:** 7-day price history for YES outcome, single SVG line, no axes. Data from Worker `/history?market=<id>&days=7`.
- **Volume / Liquidity:** "$1.2M volume · $340k liquidity" — labels accurate, not "traders".
- **Orderbook:** Best bid / Best ask / Spread (e.g. "23¢ / 25¢ · 2¢ spread"). From Worker `/orderbook?market=<id>`.

### 6.3 Resolution
- Resolves: DATE (relative + absolute)
- Source: Oracle / committee / other (from Gamma)
- Rules: first 2 lines of `description`, "Show more" expands

### 6.4 Order form
- Side toggle: YES / NO (large pill)
- Size input: USD amount (default $20), min/max validated
- Calculated:
  - Shares = size / price
  - Max payout = shares × $1 (since payout is $1 per share if correct)
  - Return % = (max payout − size) / size × 100
  - Slippage estimate from orderbook depth at chosen size
- Submit button: "Place order — sign in wallet"

### 6.5 Order confirm modal
- Summary: side, size, price, expected payout
- "Sign in wallet" CTA
- After sign: spinner → "Submitted, waiting for fill" → final status

---

## 7. WALLETCONNECT v2 INTEGRATION

**Library:** `@walletconnect/sign-client` v2.x.

**Why not injected `window.ethereum`:** Chrome extension popups run at `chrome-extension://` origin where wallet extensions do not inject providers. WalletConnect bypasses this entirely by using a relay (WSS) and deeplinks/QR.

**Init (in popup, lazy on first Connect click):**
```ts
import { SignClient } from '@walletconnect/sign-client'

const client = await SignClient.init({
  projectId: process.env.WC_PROJECT_ID, // from cloud.walletconnect.com
  metadata: {
    name: 'Actually',
    description: 'What markets really think',
    url: 'https://actually.app',
    icons: ['https://actually.app/icon-128.png'],
  },
})
```

**Connect flow:**
1. `client.connect({ requiredNamespaces: { eip155: { methods: ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign'], chains: ['eip155:137'], events: [] } } })`
2. Receive `uri` → show QR + "Open in wallet" deeplink
3. On user approval: receive session, store topic in `chrome.storage.local`
4. Read EOA address from session.namespaces.eip155.accounts[0]
5. Compute Safe address via CREATE2 (clob-client-v2 helper or manual)

**Signing an order:**
```ts
const sig = await client.request({
  topic: session.topic,
  chainId: 'eip155:137',
  request: {
    method: 'eth_signTypedData_v4',
    params: [eoaAddress, JSON.stringify(typedData)]
  }
})
```

**Session persistence:** WC v2 persists sessions across popup opens via `chrome.storage.local`. On popup reopen, `client.session.getAll()` returns active sessions; we restore the topic.

**Disconnect:** explicit user action in Settings → `client.disconnect({ topic, reason })`.

---

## 8. CLOB v2 INTEGRATION

**Library:** `@polymarket/clob-client-v2` (the v1 `@polymarket/clob-client` is archived as of May 2026).

**Initialization in popup:**
```ts
import { ClobClient, Chain, Side } from '@polymarket/clob-client-v2'

const clobClient = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: Chain.POLYGON, // 137
  signer: wcEthersSigner, // wrapper around WC v2 client
  signatureType: 2,       // POLY_GNOSIS_SAFE — 99% of Polymarket users
  funderAddress: safeAddress, // derived via CREATE2
})

const creds = await clobClient.createOrDeriveApiKey() // one-time, requires sig
// store creds.key, creds.secret, creds.passphrase in chrome.storage.local
```

**The WC ethers signer wrapper** is the only non-trivial piece — see `src/background/wallet.ts`. It implements ethers v6 `AbstractSigner` and forwards `signTypedData` to WC `eth_signTypedData_v4`.

**Placing an order:**
```ts
const response = await clobClient.createAndPostOrder(
  {
    tokenID: market.clobTokenIds[outcomeIndex], // YES or NO token
    price: 0.23,
    size: 86.96, // shares, not USD — convert in OrderForm
    side: Side.BUY,
    builderCode: process.env.BUILDER_CODE, // hardcoded — ours, not user's
  },
  { tickSize: '0.01', negRisk: market.negRisk ?? false }
)
```

**Important:**
- `builderCode` is **our** bytes32 (one per app), **not** user-configurable. Hardcoded in build via env, exposed read-only in Settings for transparency.
- The current `Settings.builderCode` field that lets users type their own is **removed** in v2 — it was a bug, not a feature.

---

## 9. WORKER ENDPOINTS

| Path | Method | Auth | Rate | Purpose |
|---|---|---|---|---|
| `/health` | GET | none | none | liveness |
| `/markets` | GET | X-Actually-Auth | 30/min/IP | Gamma proxy |
| `/price` | GET | X-Actually-Auth | 120/min/IP | CLOB price |
| `/orderbook` | GET | X-Actually-Auth | 60/min/IP | CLOB orderbook (NEW) |
| `/history` | GET | X-Actually-Auth | 60/min/IP | Gamma price-history (NEW) |
| `/geo` | GET | X-Actually-Auth | 10/min/IP | returns `CF-IPCountry` and blocked flag (NEW) |
| `/clob/order` | POST | X-Actually-Auth | 60/min/IP | proxies signed order to CLOB (NEW) |
| `/embeddings` | POST | X-Actually-Auth | 60/min/IP | OpenAI fallback (server-side key) |
| `/telemetry` | POST | X-Actually-Auth | 30/min/IP | event ingest |
| `/order` | POST | — | — | **REMOVED** — replaced by `/clob/order` |

**Auth hardening (fix from audit):**
- If `WORKER_SHARED_SECRET` env var is **unset**, all authenticated endpoints return **503 misconfigured**, not bypass-allow as in the previous version. Dev mode requires an explicit `WORKER_DEV_MODE=true` env to bypass auth.
- If `ALLOWED_EXTENSION_ID` is unset, CORS origin defaults to a literal `"none"` value (effectively blocking browsers), not `*`. Operators must explicitly set the extension ID before going live.

---

## 10. GEO-FENCE

**Blocked countries (initial):** US, UK, FR, BE, AU, SG, TH, TW, PL, ON (Ontario, Canada — Polymarket excludes specifically).

**Source of truth:** `src/shared/constants.ts` `BLOCKED_COUNTRIES`. Operator can override via Worker env `EXTRA_BLOCKED_COUNTRIES` (CSV).

**Check timing:**
- Worker `/geo` is called when the user opens Trade tab for the first time per session
- Result is cached in popup memory for the session (not persisted — country can change)
- If blocked: Trade tab renders `<GeoBlock>` with explainer text + link to Polymarket terms

**What is geo-gated:** order placement, wallet connect (we don't even show Connect button in restricted regions).
**What is NOT geo-gated:** discovery odds, market info, sparkline, link out to Polymarket (Polymarket itself enforces its own block).

---

## 11. SETTINGS & STORAGE

```ts
interface Settings {
  // Display
  confidenceThreshold: number    // computed from provider defaults
  lowConfidenceFloor: number
  locale: 'en' | 'es' | 'pt-BR'
  telemetryEnabled: boolean

  // Embeddings
  embeddingProvider: 'local' | 'openai'
  // openaiKey REMOVED — was unused; OpenAI route uses Worker env key

  // Worker (advanced, hidden behind "Advanced" toggle for v1)
  workerUrl: string
  workerSecret: string

  // Wallet (managed by trade flow, not user-editable)
  wcSessionTopic?: string
  walletAddress?: string         // EOA from WC
  safeAddress?: string           // derived
  clobApiKey?: string            // returned by createOrDeriveApiKey
  clobApiSecret?: string
  clobApiPassphrase?: string

  // builderCode REMOVED from user-editable settings — hardcoded per build
  // powerMode REMOVED — not a v1 concept anymore; trading is the main flow
}
```

**Storage keys** (`chrome.storage.local`):
- `settings` — above
- `marketCache` — array of PolyMarket with embeddings (Float32Array → Array<number> for JSON)
- `marketCacheTs` — last refresh ms
- `marketCacheModel` — model ID, invalidates cache on change
- `history` — last 10 matches
- `installId` — anonymous UUID for telemetry
- `telemetryQueue` — pending events
- `lastMatchByUrl` — dedup within HISTORY_DEDUP_MINUTES

---

## 12. CACHE TTL — actually wire it

Current code defines `CACHE_TTL_MINUTES = 30` but never uses it. Fix:

- On `CHECK_PAGE`, if `Date.now() - marketCacheTs > CACHE_TTL_MINUTES * 60_000`, kick off background refresh **after** returning current match (don't block the user)
- On install + on alarm `refresh-cache` (every 30 min), trigger refresh
- Service worker registers `chrome.alarms.create('refresh-cache', { periodInMinutes: 30 })` — alarm wakes SW briefly, which posts a message that the popup picks up next open, OR uses offscreen document if we need true background refresh (deferred — v1 lazy refresh is fine)

For v1, lazy refresh (check TTL on each match, refresh if stale, non-blocking) is sufficient.

---

## 13. SECURITY POSTURE

| Risk | Mitigation |
|---|---|
| `WORKER_SHARED_SECRET` leaked in repo (audit found 3 scripts) | Rotated, removed from repo, scripts read from env, `.env.local` gitignored |
| Worker accepted unauthenticated requests when secret unset | Fail-closed: 503 if unset, explicit `WORKER_DEV_MODE` flag for dev |
| CORS defaulted to `*` when `ALLOWED_EXTENSION_ID` unset | Fail-closed: blocked unless extension ID set |
| `optional_host_permissions: ["https://*/*"]` unused | Removed from manifest |
| Real Cloudflare `account_id` and KV `id` in committed wrangler.toml | Replaced with placeholders, real values in `wrangler.toml.example` (gitignored copy) or env |
| Hardcoded OpenAI key UI field that did nothing | Removed |
| `npm audit` 14 vulns (1 critical via @xenova/transformers → onnxruntime-web) | Track upstream fixes; vulns are in WASM bundle, not exfil-capable from extension origin, but flag for review |
| Remote model download from HuggingFace at runtime (`env.allowLocalModels = false`) | Acceptable for v1 (CWS allows it). Consider bundling later. |
| User signs arbitrary EIP-712 from extension | Order payload shown in confirm modal before sig request; we never request blanket `eth_sign` |
| Wallet credentials in `chrome.storage.local` | Encrypted at rest by Chrome profile keyring; consider chrome.storage.session for ephemeral state |

---

## 14. TELEMETRY & KPIs

**Honest event list** (in `src/background/telemetry.ts` — current version only fires `install`):

- `install`
- `check_page_clicked`
- `match_shown` (with color, confidence bucket, market id hash)
- `match_clicked` (clicked out to Polymarket)
- `wallet_connect_started`
- `wallet_connect_success`
- `wallet_connect_failed` (with reason bucket)
- `order_form_opened`
- `order_signed`
- `order_submitted` (with size bucket, side, market id hash)
- `order_filled` (polled status)
- `geo_blocked` (with country code)
- `cache_refresh` (success/failure, market count)

**Privacy:** all events keyed by anonymous `installId` UUID. No URLs, no headlines, no wallet addresses. Only hashed market id + size bucket.

**KPIs split by audience:**

| KPI | Normie | Crypto-native |
|---|---|---|
| Installs | ✓ primary | ✓ primary |
| DAU / WAU | ✓ primary | ✓ |
| `match_shown` / install / week | ✓ primary | ✓ |
| `match_clicked` rate | ✓ primary | — |
| `wallet_connect_success` rate | — | ✓ primary |
| `order_submitted` per WAU | — | ✓ primary |
| Builder-attributed volume (from Polymarket builder dashboard) | — | ✓ primary, **the** money KPI |
| Median time install → first order | — | ✓ |

---

## 15. OUT OF SCOPE FOR v1

- Content script / in-page widget (Shadow DOM, glassmorphism) — deferred indefinitely, was never built
- Embedded wallet (Privy / Magic / Turnkey) — explicitly rejected; users bring their own wallet
- Onramp deeplink — user funds their wallet themselves
- Copy trading, alerts, position tracking
- Multi-language LLM-driven explainers (current explainer is template-based)
- Mobile companions (iOS Share Extension, Android, Telegram bot) — separate roadmap, not v1
- USDC approve flow — Safe wallet doesn't need it; if user is EOA (signatureType 0) we show "Use a Polymarket Safe wallet, EOA mode is unsupported in v1"

---

## 16. IMPLEMENTATION ORDER

Numbered tasks for sequential execution. Each task should be a self-contained PR.

**Block A — security/hygiene (in flight, partly done)**
1. ✅ Update spec (this doc)
2. ✅ Remove secrets from `scripts/*.mjs`, use env, add `.env.example`
3. ✅ Replace real CF IDs in `wrangler.toml` with placeholders
4. Worker auth fail-closed: 503 if `WORKER_SHARED_SECRET` unset (unless `WORKER_DEV_MODE=true`); CORS deny if `ALLOWED_EXTENSION_ID` unset
5. Remove `optional_host_permissions` from manifest
6. Remove `openaiKey` field from Settings UI and `Settings` type (kept on Worker as env var)
7. Remove `builderCode` user field from Settings UI; hardcode build-time via `process.env.BUILDER_CODE` in Vite; show read-only in Settings under "About"
8. Remove `powerMode` toggle and field — replaced by wallet-connected state
9. Rewrite `actually-growth-strategy.md` to reflect dual audience + builder-volume KPI

**Block B — trade infrastructure**
10. Add `@walletconnect/sign-client`, `@polymarket/clob-client-v2`, `ethers@6` to deps
11. Write `src/background/wallet.ts` — WC v2 init, connect, session restore, ethers-signer wrapper
12. Write `src/background/clob.ts` — clob-client-v2 init, API key derive, persist creds
13. Write `src/background/trade.ts` — order construction with `builderCode`, submit
14. Write `src/background/geo.ts` — fetch `/geo`, cache for session
15. Worker: add `/orderbook`, `/history`, `/geo`, `/clob/order`; remove old `/order` 501 stub

**Block C — trade UI**
16. `popup/trade/ConnectButton.tsx`
17. `popup/trade/OrderForm.tsx` + size/payout calc
18. `popup/trade/Sparkline.tsx`
19. `popup/trade/Orderbook.tsx`
20. `popup/trade/ResolutionCard.tsx`
21. `popup/trade/PayoutPreview.tsx`
22. `popup/trade/GeoBlock.tsx`
23. Refactor `TradePanel.tsx` to compose the above
24. Wire confirm modal + status polling

**Block D — quality**
25. Cache TTL wiring (alarm + lazy refresh on stale)
26. CheckPage: "$X volume" instead of "X traders"
27. Honest telemetry events (all 13 above) — wire and verify with local Worker
28. i18n: trade.* keys filled in EN/ES/PT-BR
29. Tests: matcher fixtures, cache diff, URL builder, Worker auth, geo logic. Wire vitest properly (currently has zero tests)
30. `npm audit` triage — bump or replace what's bumpable

**Block E — release readiness**
31. Privacy policy update (wallet connection, geo check, order routing)
32. Terms of Service draft (trading disclaimer, no-advice, builder fee disclosure)
33. CWS listing assets: screenshots showing BOTH modes, video walkthrough
34. Beta with small group (10-20 crypto-native, 10-20 normies), iterate
35. Public launch — Product Hunt + CryptoTwitter coordinated

---

## 17. APPENDIX — preserved decisions from v1.0

These were in the v1.0 spec and remain valid:

- **`activeTab` permission only**, no broad host permissions
- **Local-first embeddings** via transformers.js; OpenAI is optional fallback through Worker
- **`Xenova/all-MiniLM-L12-v2`** (384-dim) — cosine similarity thresholds calibrated against 300 real markets
- **300-market cache** ceiling for cold-start performance
- **`utm_source=actually`** on click-out URLs for our own funnel analytics — does NOT produce builder attribution
- **Color thresholds:** blue ≤ 30%, yellow 30-60%, red ≥ 60% (probability-of-YES color = "smoke")
- **Headline weighted 2x** in embedding input vs body
- **Noise-question patterns** filtered (word-association markets that dominate matches with no signal)

---

**End of spec.**
