# ACTUALLY — Chrome Extension
## Technical Spec v2.1
**Version:** 2.1 | **Date:** May 2026
**Supersedes:** v2.0 (this same month) — see git history for previous version.

> v2.1 reflects the implementation-audit pass:
> - **Architecture:** popup-only UX is back to the front (v2.0 briefly experimented
>   with a Shadow-DOM widget injected on every page; reverted because the
>   `<all_urls>` content-script permission inflates the CWS prompt past the
>   normie-acquisition threshold). In-page widget moved to v1.2 backlog.
> - **Offscreen Document** added as the heavy-ops home (transformers.js,
>   WalletConnect v2, CLOB signing) — MV3 service-worker constraints made the
>   in-popup design from v2.0 impractical.
> - **Order routing:** direct from extension to `clob.polymarket.com` for v1.
>   The Worker `/clob/order` proxy from v2.0 §9 is deferred to v1.2 (paired
>   with HMAC-signed `X-Actually-Auth`). See §9 for the trade-off.
> - **Worker shared secret** is explicitly framed as a baked-in client token,
>   not a true secret — see §13 threat model.
> - **Typography:** single-family (Marck Script), self-hosted woff2. The v2.0
>   triplet of Inter / Instrument Serif / JetBrains Mono is retired.
> - Audience and product mechanic unchanged from v2.0 (dual-mode, builderCode).
> - Local embedding model unchanged: `Xenova/all-MiniLM-L12-v2` (384-dim).

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
│  Chrome Extension (popup-only — no content script in v1)     │
│                                                                │
│  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Check      │  │ Trade      │  │ History  │  │ Settings │  │
│  │ (default)  │  │ (wallet+)  │  │          │  │          │  │
│  └──────┬─────┘  └──────┬─────┘  └────┬─────┘  └────┬─────┘  │
│         │               │             │             │         │
│         ▼               ▼             ▼             ▼         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ popup runtime (React, light) — UI state + chrome.*     │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                            │ chrome.runtime.sendMessage       │
│                            ▼                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Service Worker — install, alarms, storage proxy,       │  │
│  │   message router. Forwards "heavy" ops to offscreen.   │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                            │ chrome.runtime.sendMessage       │
│                            ▼                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Offscreen Document — transformers.js embeddings,       │  │
│  │   WC v2 SignClient, CLOB v2 client + signing.          │  │
│  │   Owns the heavyweight long-lived state.               │  │
│  └────────────────────────┬───────────────────────────────┘  │
└────────────────────────────┼──────────────────────────────────┘
                             │ HTTPS + X-Actually-Auth          │ Direct HTTPS
                             ▼                                   │ (CLOB only)
┌───────────────────────────────────────────────────────────┐   │
│  Cloudflare Worker (actually-api)                         │   │
│  /markets   Gamma proxy + cache                           │   │
│  /price     CLOB price proxy                              │   │
│  /orderbook CLOB orderbook proxy                          │   │
│  /history   Gamma price-history proxy                     │   │
│  /geo       client geo check via CF headers               │   │
│  /clob/proxy/<eoa>  Safe (funder) lookup                  │   │
│  /embeddings  OpenAI fallback                             │   │
│  /telemetry  anonymous event ingest                       │   │
│  /clob/order  ← deferred to v1.2 (see §9)                 │   │
└────────────────────────────┬──────────────────────────────┘   │
                             │                                   ▼
                             ▼                          ┌──────────────────────┐
                    Polymarket Gamma                    │ clob.polymarket.com  │
                    (markets, history)                  │ (signed orders, GET  │
                                                        │  book / price)       │
                                                        └──────────────────────┘
```

**Service Worker role:** lightweight only. Lifecycle hooks (install, alarms), telemetry queue flush, settings/history storage proxy, message routing. **All heavy work happens in the offscreen document** — MV3 service workers cannot host WASM, WebSockets to WC relays, or long-running clob-client state.

**Offscreen Document role:** the actual heavy-ops home. `chrome.offscreen.createDocument` is invoked lazily on the first heavy message. Lives at `chrome-extension://<id>/src/offscreen/offscreen.html`, has full Web API (WASM, WSS, IndexedDB), and is kept alive across SW restarts. Hosts:
- The transformers.js MiniLM-L12 pipeline (model load + embedding).
- The WalletConnect v2 `SignClient` and its session topic.
- The `@polymarket/clob-client-v2` instance with its `ApiKeyCreds`.
- The order-construction + sign + submit flow.

**Popup role:** React UI only. Sends typed messages to the SW, which forwards `target: 'offscreen'` messages to the offscreen doc and pipes responses back.

**Worker role:** thin authenticated proxy for Gamma + OpenAI + geo. Adds per-IP rate limits, fail-closed CORS allowlist. The Worker does **not** sign orders, and (in v1) does **not** proxy signed orders either — those go direct from the extension to `clob.polymarket.com`. See §9 for the deferred `/clob/order` proxy plan.

---

## 3. FILE STRUCTURE

```
extension/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts            # build-time CSP tightening + entry points
├── vitest.config.ts
├── .env.example              # VITE_* and runtime env for scripts/
├── .gitignore                # also blocks *.zip / *.tar.gz / *.crx
├── README.md
├── SECURITY.md               # threat model, npm audit, hardening
├── docs/
│   ├── privacy-policy.md
│   └── terms-of-service.md
│
├── src/
│   ├── background/           # SW + helpers shared with offscreen
│   │   ├── index.ts          # SW: install, alarms, message router → offscreen
│   │   ├── offscreen-host.ts # ensureOffscreen + routeToOffscreen
│   │   ├── cache.ts          # diff-cache + TTL refresh (called from offscreen)
│   │   ├── embeddings.ts     # local MiniLM-L12 + OpenAI provider
│   │   ├── extractor.ts      # headline + body, runs via scripting.executeScript
│   │   ├── matcher.ts        # cosine-sim + noise filters + tiebreak
│   │   ├── polymarket.ts     # Gamma fetch, tickSize normalization, URL builder
│   │   ├── history.ts        # last 10 matches with URL dedup
│   │   ├── settings.ts       # chrome.storage wrapper
│   │   ├── telemetry.ts      # event queue + 1000-event cap + flush
│   │   ├── trade.ts          # orchestrator: connect, placeOrder w/ staged tel
│   │   ├── wallet.ts         # WC v2 SignClient + WCSigner
│   │   ├── clob.ts           # clob-client-v2 init, sign/submit split, polling
│   │   ├── geo.ts            # geo check + blocklist
│   │   └── util.ts           # sha256, b64↔float, cosine, findOutcomeIndex,
│   │                         #   safeJsonArray, formatRelative, shortHash
│   │
│   ├── offscreen/            # heavy-ops home (see §3.5)
│   │   ├── offscreen.html
│   │   └── offscreen.ts      # message handler — match, refresh, wallet ops
│   │
│   ├── popup/                # thin entry, mounts IntegratedPopup from popup_new
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── operations.ts     # extractActiveTabArticle + live-price fetch
│   │
│   ├── popup_new/            # the actual UI (glass design system)
│   │   ├── IntegratedPopup.tsx  # tab router + wiring
│   │   ├── TradeTabWired.tsx    # connect flow + analytics + order form
│   │   ├── ops.ts            # popup-side adapter for offscreen RPCs
│   │   ├── colors.ts
│   │   ├── fonts.css         # single @font-face → Marck Script
│   │   ├── styles.css        # frost / ice / glass-btn primitives
│   │   ├── components/       # Etched, GlassButton, IceCard, Tabs, …
│   │   ├── tabs/             # CheckTab, HistoryTab, SettingsTab, TradeTab
│   │   └── trade/
│   │       └── Analytics.tsx # Sparkline + Orderbook + ResolutionCard +
│   │                         #   MarketAnalytics composer
│   │
│   └── shared/
│       ├── constants.ts      # thresholds, colors, model id, BUILDER_CODE
│       ├── messages.ts       # SW ↔ offscreen ↔ popup message types
│       └── types.ts          # Settings, PolyMarket (+ tickSize), MatchResult
│
├── public/
│   ├── icon-{16,48,128}.png
│   └── fonts/
│       └── MarckScript-Regular.woff2   # produced by `npm run fonts:fetch`
│
├── scripts/                  # ALL read URL+secret from env, never hardcode
│   ├── fetch-fonts.mjs       # populate public/fonts/ from Google Fonts
│   ├── probe.mjs             # quick /markets probe
│   └── test-{match,final}.mjs / compare-models.mjs   # offline matcher iteration
│
└── worker/
    ├── wrangler.toml         # placeholders only — real ids never committed
    ├── wrangler.toml.example
    └── index.ts
```

**Removed since v2.0 / earlier audit pass:** `src/popup/{App,CheckPage,History,
Settings,TradePanel}.tsx`, `src/popup/styles.css`, `src/popup/trade/*`, and
`src/content/inject.tsx` — all collapsed into the single `popup_new/`
implementation that the popup HTML entry now mounts directly. `src/i18n/*` and
the `Settings.locale` field were also removed — the v1 UI is English-only.

### 3.5 Offscreen Document — rationale and boundary

MV3 service workers cannot:
- run WebAssembly with the lifetime transformers.js needs (model load is ~3 s,
  embedding batches several seconds; SW lifetime is opportunistic ~30 s).
- hold a WebSocket open (WalletConnect v2 relay).
- carry the SDK state required by `clob-client-v2` across messages.

v2.0 attempted to live in the popup runtime; popup death on close kills the
WC session and forces a re-derive on every reopen. Offscreen documents are
the only MV3-correct place for this state.

The offscreen document is created lazily on the first heavy message
(`OS_RUN_MATCH`, `OS_START_CONNECT`, `OS_PLACE_ORDER`, …) and kept alive by
Chrome until idle. All long-lived state — model pipeline, WC session, CLOB
credentials, in-memory geo cache — lives here. The popup never accesses
`@xenova/transformers`, `@walletconnect/sign-client`, or
`@polymarket/clob-client-v2` directly; it only sends `target: 'offscreen'`
messages via the SW router.

---

## 4. MANIFEST V3

```jsonc
{
  "manifest_version": 3,
  "name": "Actually — What Markets Really Think",
  "version": "1.0.0",

  "permissions": ["storage", "activeTab", "alarms", "scripting", "offscreen"],
  "optional_permissions": [],
  "host_permissions": ["https://clob.polymarket.com/*"],

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
    "extension_pages":
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; " +
      "connect-src 'self' https://<your-worker>.workers.dev " +
      "  https://clob.polymarket.com https://gamma-api.polymarket.com " +
      "  https://data-api.polymarket.com https://api.openai.com " +
      "  https://huggingface.co https://*.hf.co " +
      "  https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com " +
      "  wss://*.walletconnect.com wss://*.walletconnect.org wss://*.reown.com; " +
      "img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'"
  }
}
```

**Notes:**
- **No content scripts.** Page reading happens on click via
  `chrome.scripting.executeScript({ func: extractFromPage })` against the
  `activeTab` permission. CWS prompt is just "Read your browsing history" — the
  minimal acceptable for the discovery mechanic.
- `host_permissions` lists exactly **one** host: `clob.polymarket.com`. This is
  the deliberate v1 trade-off (see §9). Gamma + data-api are accessed via the
  Worker, so they need not appear here.
- `offscreen` permission allows `chrome.offscreen.createDocument` (see §3.5).
- `connect-src` includes the exact Worker host (substituted at build time from
  `VITE_WORKER_URL` — see `vite.config.ts`). Dev builds keep `*.workers.dev`
  as fallback; production builds inline a single concrete origin.
- `font-src 'self'` — fonts are self-hosted (Marck Script woff2 in
  `public/fonts/`). No third-party origins are reached at runtime for fonts.
- `script-src 'wasm-unsafe-eval'` is required by ONNX-runtime-web for the
  local embedding model.

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

Before any trading UI renders, the popup calls Worker `/geo` (CF returns `CF-IPCountry`). If the country is a **confirmed** blocklist member (US, UK, FR, BE, AU, SG, TH, TW, PL, others — see §10), the Trade tab hard-blocks order placement. **Unknown region (`GEO_FAIL_OPEN`):** if the lookup can't be performed (Worker misconfig / network → `unknown`), prod builds pause trading (fail-closed) while dev/beta proceed with an inline warning — and Polymarket enforces its own block at order time either way. Discovery works regardless — info is not geo-gated.

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
1. `client.connect({ requiredNamespaces: { eip155: { methods: ['eth_signTypedData_v4'], chains: ['eip155:137'], events: ['chainChanged', 'accountsChanged'] } } })` — we only ever request EIP-712 typed-data signatures; no `eth_sendTransaction`/`personal_sign`.
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
| `/orderbook` | GET | X-Actually-Auth | 60/min/IP | CLOB orderbook |
| `/history` | GET | X-Actually-Auth | 60/min/IP | Gamma price-history (sparkline) |
| `/geo` | GET | X-Actually-Auth | 10/min/IP | returns `CF-IPCountry` + blocked flag |
| `/clob/proxy/<eoa>` | GET | X-Actually-Auth | 30/min/IP | Polymarket Safe (funder) lookup |
| `/embeddings` | POST | X-Actually-Auth | 60/min/IP | OpenAI fallback (server-side key) |
| `/telemetry` | POST | X-Actually-Auth | 30/min/IP | event ingest |

### 9.1 Order routing — direct CLOB for v1 (deferred Worker proxy)

The v2.0 spec called for `POST /clob/order` as a Worker proxy that would
forward signed orders to `clob.polymarket.com`. In v1 we ship without it
and the extension posts orders directly to CLOB. The trade-off:

**Why direct CLOB in v1:**
1. CLOB authenticates every request via per-user HMAC headers (`POLY_API_KEY`,
   `POLY_PASSPHRASE`, `POLY_SIGNATURE`) built from creds derived during
   connect. The Worker can neither validate nor re-sign these — it would
   be a transparent pass-through.
2. To make the proxy worthwhile we'd want CLOB GETs (orderbook, price,
   status polling) to go through it too. That would multiply latency and
   force Worker rate limits high enough to not break real-user polling,
   which neuters the rate-limit-as-DoS-protection idea.
3. One fewer moving part for v1 review/beta.

**Cost:** `host_permissions: ["https://clob.polymarket.com/*"]` in manifest
— a single, public, well-known host. Reviewable.

**Planned v1.2:** re-introduce `POST /clob/order` paired with HMAC-signed
`X-Actually-Auth` (timestamp + nonce + body MAC). At that point the Worker
adds real value: per-IP order-rate limit + server-side geo re-check on
submit + revocable secret rotation. The `host_permissions` line can then
go away entirely.

### 9.2 Auth hardening (fail-closed)

- If `WORKER_SHARED_SECRET` env var is **unset**, every authenticated
  endpoint returns **503 misconfigured**. Dev mode requires an explicit
  `WORKER_DEV_MODE=true` env to bypass.
- If `ALLOWED_EXTENSION_ID` is unset, `Access-Control-Allow-Origin` echoes
  `https://__actually_misconfigured__.invalid` (never matches any browser
  origin). Operators see the misconfig in DevTools rather than getting
  silent `*`-style passthrough.
- The shared secret is also baked into the extension build via
  `VITE_WORKER_SECRET` — see §13 for the threat model.

---

## 10. GEO-FENCE

**Blocked countries (initial):** US, UK, FR, BE, AU, SG, TH, TW, PL, ON (Ontario, Canada — Polymarket excludes specifically).

**Source of truth:** `worker/index.ts` `BLOCKED_COUNTRIES` (authoritative at request time), mirrored client-side in `src/background/geo.ts`. Operator can override via Worker env `EXTRA_BLOCKED_COUNTRIES` (CSV).

**Check timing:**
- Worker `/geo` is called when the user opens the Trade tab (cached in popup memory for the session — country can change between sessions).

**Posture — build-flagged (`GEO_FAIL_OPEN`, see `src/shared/constants.ts`):**
- **Confirmed restricted** (`blocked && !unknown`): the Trade tab hard-blocks wallet connect + order placement and shows a region notice — always, regardless of the flag.
- **Unknown** (Worker misconfig / network / 401 / 503 / no country): governed by `GEO_FAIL_OPEN`. **Production builds fail closed** — connect + placement are paused until the region is confirmed. **Dev/beta builds fail open** — trading proceeds with an inline warning. In both cases Polymarket independently enforces its own jurisdiction block at order time, and the `geo_unknown` telemetry event tracks how often the lookup fails. The default resolves to closed in `vite build` (prod) and open in dev; `VITE_GEO_FAIL_OPEN=true|false` overrides.

**What is geo-gated:** order placement + wallet connect — but only on a *confirmed* restricted country.
**What is NOT geo-gated:** discovery odds, market info, sparkline, link-out; and trading when geo is `unknown` **only in fail-open (dev/beta) builds** (see posture above).

---

## 11. SETTINGS & STORAGE

```ts
interface Settings {
  // Display
  confidenceThreshold: number    // computed from provider defaults
  lowConfidenceFloor: number
  // locale REMOVED — v1 UI is English-only (i18n layer dropped)
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
| `WORKER_SHARED_SECRET` baked into every public extension build | **Acknowledged.** This token is a client-side anti-accidental-load defense, NOT a secret. Per-IP rate limit and global per-day OpenAI cap are the real backstops. Planned v1.2: HMAC-signed `X-Actually-Auth` (timestamp + nonce + body MAC). See `SECURITY.md` for full threat model. |
| Previously: hardcoded secret in `scripts/probe.mjs` + real KV id / extension id in `wrangler.toml` | Rotated, scripts now read from env, wrangler placeholders + `wrangler.toml.example` committed. Verified clean. |
| Worker accepted unauthenticated requests when secret unset | Fail-closed: 503 if unset, explicit `WORKER_DEV_MODE=true` for dev. |
| CORS defaulted to `*` when `ALLOWED_EXTENSION_ID` unset | Fail-closed: echoes `https://__actually_misconfigured__.invalid` (never matches). |
| Content script on `<all_urls>` would inflate CWS permission prompt | Removed; popup-only UX with `activeTab` on click. Widget deferred to v1.2. |
| `*.workers.dev` wildcard in CSP `connect-src` | Replaced at build time (`VITE_WORKER_URL`) with the exact production Worker origin. Dist manifest contains a single concrete host. |
| Remote Google Fonts `@import` at runtime | Removed. Self-hosted Marck Script woff2 via `npm run fonts:fetch`. `font-src 'self'`. |
| Remote model download from HuggingFace at runtime (`env.allowLocalModels = false`) | Acceptable for v1 (one-time, cached). Planned v1.1: bundle the MiniLM-L12-v2 weights into the .crx to remove `huggingface.co` from CSP. |
| User signs arbitrary EIP-712 from extension | Order payload (side, size, price) shown in the form before "Place order — sign in wallet" CTA. We never request `eth_sign`. |
| Wallet credentials (`clobApiKey/secret/passphrase`) in `chrome.storage.local` | Encrypted at rest by Chrome profile keyring. **Settings → Wallet → "Disconnect & wipe"** clears creds + WC session on demand. |
| Telemetry queue growing unbounded if Worker unreachable | Capped at 1000 most-recent events in `chrome.storage.local`. |
| `npm audit` advisories in transitive deps | Triaged in `SECURITY.md`. Dev-only (`rollup`, `wrangler` chain) or in non-exercised code paths (`@ethersproject/*` signing primitives — we sign exclusively via the user's wallet). No breaking forced-fix applied. |

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

- **In-page Shadow-DOM widget** — deferred to v1.2. v2.0 prototype existed
  briefly but was reverted (see header) because the `<all_urls>` content-script
  permission gates the normie-discovery acquisition channel. If revived, it
  will be opt-in via `chrome.permissions.request({ origins: ['<all_urls>'] })`
  after the user opts into it explicitly.
- **Worker `/clob/order` proxy** — deferred to v1.2 (see §9.1).
- **HMAC-signed `X-Actually-Auth`** — deferred to v1.2 (see §13).
- **Bundled local embedding model** — deferred to v1.1 (see §13).
- Embedded wallet (Privy / Magic / Turnkey) — explicitly rejected; users
  bring their own wallet.
- Onramp deeplink — user funds their wallet themselves.
- Copy trading, alerts, position tracking, sell-to-close.
- Multi-language LLM-driven explainers (current explainer is template-based).
- Mobile companions (iOS Share Extension, Android, Telegram bot) — separate
  roadmap, not v1.
- USDC approve flow — Safe wallet doesn't need it; if user is EOA
  (signatureType 0) we show "Use a Polymarket Safe wallet, EOA mode is
  unsupported in v1".

---

## 16. IMPLEMENTATION ORDER — status as of v2.1

Tracked by sprint, not numbered task. Each sprint was a self-contained merge.

**Sprint 0 — Security & build reproducibility** ✅
- Hardcoded `WORKER_SHARED_SECRET` removed from `scripts/probe.mjs`
- `worker/wrangler.toml` placeholders + `wrangler.toml.example` created
- `actually-v2-dev.tar.gz/.zip` removed from repo + `.gitignore` updated
- Verified: clean `grep` for known leaked tokens, `npm run build` zelёный

**Sprint 1 — Architecture rollback to popup-only + offscreen** ✅
- `content_scripts` and `web_accessible_resources` removed from manifest
- `action.default_popup` restored; `chrome.action.onClicked` widget toggle gone
- Legacy `src/popup/{App,CheckPage,History,Settings,TradePanel}.tsx` + `popup/trade/*` + `src/content/inject.tsx` deleted
- `popup/main.tsx` mounts `IntegratedPopup` from `popup_new`
- Demo `popup_new/index.tsx` moved to `dev/preview/`

**Sprint 2 — Critical UX bugs** ✅
- CheckTab `LinkAction` callbacks wired (`onOpenMarket`, `onTrade`) — dead links fixed
- YES/NO token mapping for live price (no more "NO price labelled YES")
- `lvl_or_zero(lvl, …)` ReferenceError fix in `trade.ts`
- Wallet "Disconnect & wipe" in Settings → WalletSlot
- WC poll deadline 30 min → 5 min

**Sprint 3 — Trade analytics + telemetry semantics** ✅
- Dynamic `tickSize` from Gamma (`tickSize?: string` on `PolyMarket`)
- `placeBuyOrder` split → `signBuyOrder` + `submitSignedOrder` + `pollOrderStatus`
- `placeOrder` in `trade.ts` emits telemetry in correct phases:
  `order_form_opened` at UI mount → `order_signed` after createOrder →
  `order_submitted` after postOrder → `order_filled` from background poll
- `popup_new/trade/Analytics.tsx` ships `Sparkline` + `Orderbook` + `ResolutionCard`
  composed by `<MarketAnalytics />` between IceCard and order form
- Direct CLOB routing for v1 (see §9.1) — `host_permissions: clob.polymarket.com` accepted

**Sprint 4 — Security & CWS hardening** ✅
- Self-hosted Marck Script woff2; `font-src 'self'`; `npm run fonts:fetch` script
- CSP `*.workers.dev` → exact `VITE_WORKER_URL` origin at build time
- Worker CORS deny path: `null` → `https://__actually_misconfigured__.invalid`
- Telemetry queue capped at 1000 events
- `SECURITY.md` rewritten honestly (baked-in secret threat model, etc.)

**Sprint 5 — Docs sync (this pass)** ✅
- This spec bumped to v2.1; README, privacy policy refreshed; ToS confirmed accurate.

**Sprint 6 — Tests + CI** — pending
- Miniflare-based worker tests (auth, CORS, geo, rate-limit)
- CheckTab links + YES/NO mapping unit tests
- `.github/workflows/test.yml` for PR + main

**Sprint 7 — Beta + CWS** — pending
- 10-20 crypto-native + 10-20 normie beta cohort
- CWS screenshots + 30 s walkthrough video
- Public launch via Product Hunt + CryptoTwitter

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
