# Changelog

All notable changes to the Actually browser extension.

## [Unreleased] — v1.0.0-rc1 (audit-pass)

Implements `actually-extension-spec.md` v2.1. Six sprints of remediation off
the v2.0 baseline; not yet submitted to the Chrome Web Store.

### Architecture
- Popup-only UX with an offscreen document for heavy ops (transformers.js,
  WalletConnect v2, CLOB v2). The brief v2.0 in-page Shadow-DOM widget was
  reverted to keep the CWS permission prompt minimal.
- Single UI codebase (`src/popup_new/`). Legacy `src/popup/{App,CheckPage,
  History,Settings,TradePanel}.tsx` and `src/popup/trade/*` removed.
- Service Worker is now a thin router → forwards `target: 'offscreen'`
  messages and handles only storage/alarm/install.

### Trade
- New `MarketAnalytics` composer in `popup_new/trade/Analytics.tsx`:
  7-day Sparkline + best bid/ask/spread Orderbook + ResolutionCard.
- `placeBuyOrder` split into `signBuyOrder` + `submitSignedOrder` so
  telemetry can mark `order_signed` between signature and network post.
- `order_form_opened` fires at form mount (was: at submit time).
- `order_filled` fires from a background poll of CLOB status.
- Dynamic `tickSize` from Gamma; falls back to `negRisk ? '0.001' : '0.01'`.
- USD→shares conversion derives `size` from `price` per side; BUY_NO uses
  `1 - freshPrice` so the order matches what the form preview shows.
- Wallet Settings → "Disconnect & wipe" clears WC session + CLOB
  credentials in one click.
- WC approval poll deadline cut from 30 min to 5 min.

### Discovery
- CheckTab "View on Polymarket →" and "Trade this market →" links wired —
  previously rendered as inert `<a href="#" preventDefault>`.
- Live price now resolved by YES outcome label, not `clobTokenIds[0]`.
  Markets with `outcomes=["No","Yes"]` no longer display the NO price under
  the YES label.

### Security
- `WORKER_SHARED_SECRET` is documented as a baked-in client token, not a
  secret. See `SECURITY.md` for the v1 threat model and the v1.2 plan to
  move auth to HMAC-signed `X-Actually-Auth`.
- Worker fails closed (503) when `WORKER_SHARED_SECRET` or
  `ALLOWED_EXTENSION_ID` is unset (unless `WORKER_DEV_MODE=true`).
- Worker CORS deny path: `null` → `https://__actually_misconfigured__.invalid`
  to avoid opaque-origin matching quirks.
- CSP `connect-src` rewritten from `https://*` to a concrete allowlist; the
  Worker host is pinned at build time via `VITE_WORKER_URL` so the dist
  manifest carries exactly one origin.
- Self-hosted Marck Script woff2 via `npm run fonts:fetch`; the remote
  Google Fonts `@import` was removed; `font-src 'self'`.
- Telemetry queue capped at 1000 events with drop-oldest eviction.
- Hardcoded `WORKER_SHARED_SECRET` removed from `scripts/probe.mjs`;
  `worker/wrangler.toml` carries placeholders only.
- All `*.tar.gz` / `*.zip` / `*.crx` artifacts excluded from version
  control.

### Bug fixes
- `lvl_or_zero(lvl, ...)` ReferenceError on a thin orderbook: replaced
  with a safe `asks[asks.length - 1]?.price ?? bestAsk` fallback.

### Tests
- 36 → 63 (+27): new coverage for `safeJsonArray`, `formatRelative`,
  `shortHash`, telemetry queue cap, `normalizeTick`, and a YES/NO mapping
  regression suite.
- New CI workflow (`.github/workflows/ci.yml`): lint, test, fonts:fetch,
  build with CI-stub env, assert production CSP is tightened, no-leaked-
  secrets guard, artifact upload on PR.

### Documentation
- `actually-extension-spec.md` bumped to v2.1: new §3.5 Offscreen Document,
  §9.1 direct-CLOB-for-v1 rationale, §13 threat model, §16 sprint status.
- `SECURITY.md` rewritten honestly (removed three stale claims).
- `README.md` refreshed: actual file tree, *Architecture decisions for
  v1*, reproducible-builds note for OneDrive/Cyrillic paths.
- `docs/privacy-policy.md` clarifies the activeTab-on-click permission
  model and the Disconnect & wipe path.

### Known deferrals (planned)
- v1.1 — bundle MiniLM model into the .crx; CREATE2 funder fallback;
  Miniflare-based worker tests.
- v1.2 — Worker `/clob/order` proxy paired with HMAC-signed
  `X-Actually-Auth`; opt-in in-page Shadow-DOM widget via
  `chrome.permissions.request`.
