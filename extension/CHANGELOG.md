# Changelog

All notable changes to the Actually browser extension.

## [Unreleased] — v1.0.0 (post-rc1, pre-CWS-submission)

Everything below landed after rc1 and before the first Chrome Web Store
submission. Grouped by what a user/reviewer actually cares about, not by
commit — see git history for the full detail.

### Trading — new capability
- **Open positions panel**: current Polymarket positions with cost basis and
  unrealized P&L, visible in the Trade tab without leaving the extension.
- **Resting orders, in-app cancel**: your open orders (with live status) are
  listed alongside positions, and can be cancelled directly — no round-trip
  to polymarket.com required.
- **Order-book depth**: the Trade tab now shows levels beyond best bid/ask,
  not just top-of-book.

### Security fixes
- Fixed a WalletConnect signing bug (`WCSigner._signTypedData`) that made
  every connect/order signature invalid against MetaMask/Rabby — this was
  never caught before because the live wallet flow had never been exercised
  against a real WalletConnect session.
- Added a jurisdiction check to the MCP server (`packages/mcp-server`) that
  mirrors the extension's — it previously had none.
- Extended the geo blocklist (extension + Worker + MCP server) to cover
  comprehensively OFAC-sanctioned jurisdictions (Iran, North Korea, Cuba,
  Syria), and added `EXTRA_BLOCKED_COUNTRIES` for fast additions without a
  redeploy. See Terms of Service §2.1.
- Fixed a wrong-outcome-signing gap on non-binary markets reached through a
  Gamma-API fallback path, and a stale-cache gap that could offer a
  closed/resolved market as a live, tradeable match.
- Fixed `cancelOrder` (extension + MCP server) reporting success on every
  actual CLOB failure mode — a cancel could silently not go through.
- Fixed a spend-guard gap in the MCP server's `sell_order` tool where a
  caller-supplied low price could make a large real-money sell look small to
  the per-order/daily USD caps.
- `Disconnect & wipe` now unconditionally clears local wallet
  credentials — previously a WalletConnect relay outage during disconnect
  could leave credentials in storage with no error shown.
- `/geo`'s Tor/unknown-region traffic is no longer treated as an implicitly
  allowed country.

### Privacy / telemetry
- Telemetry stays **opt-in, default off**, as before — but the tracked event
  list grew (`order_cancelled`, `order_cancel_failed`, `geo_unknown` added
  alongside the original set) and failure events (`order_failed`,
  `order_cancel_failed`) now disclose that they carry a short error-reason
  string. See `docs/privacy-policy.md` for the current, exact list.
- The bundled embedding model section (no HuggingFace/CDN fetch at install
  or runtime) was added to the privacy policy.

### Bug fixes (post-launch-test feedback)
- Fixed a History-tab link, cancel-state persistence, and a button color
  regression reported during internal test passes.

### Documentation
- `docs/cws-listing.md`, `docs/release-checklist.md`, `docs/privacy-policy.md`,
  and `docs/terms-of-service.md` synced with the above — see each file's own
  history for specifics.

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
