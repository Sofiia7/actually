# Security notes

## Threat model - what "the Worker secret" actually protects

`WORKER_SHARED_SECRET` is baked into the production extension build via
`VITE_WORKER_SECRET` and shipped to every user. Because Vite inlines `VITE_*`
into the JS bundle, **anyone who installs the extension can extract this
value from the .crx in minutes**. Treat it as a public client token, not a
secret.

What this token does provide:

- Anti-accidental-load defense (random crawlers and one-off scripts that
  don't know to set `X-Actually-Auth` get a clean 401).
- A single rotation point if abuse spikes - bumping the secret + rebuilding
  the extension forces all clients to upgrade.

What it does **not** provide:

- No defense against a motivated attacker draining the per-day OpenAI quota
  or pumping rate-limited routes. The Worker's KV-based per-IP rate limit
  and the global `openai_day:<date>` cap are the real backstops.

Planned v1.2: HMAC on `X-Actually-Auth` keyed by `(timestamp, nonce, body)`
so even a leaked secret can't replay or forge requests indefinitely. Until
then, rotate the secret if abuse is detected and accept the limited
defense above.

## Worker hardening

- **Fail-closed auth**: the Worker returns 503 if `WORKER_SHARED_SECRET` is
  unset, unless `WORKER_DEV_MODE=true` is explicitly opted in.
- **Fail-closed origin allowlist**: 503 if `ALLOWED_EXTENSION_ID` is unset.
- **Fail-closed rate-limit backstop**: 503 if the `RATE_LIMITER_DO` Durable
  Object binding is not bound. Because the shared secret is publicly
  extractable from the build, the per-IP rate limit and the OpenAI daily cap
  are the *real* abuse defense - so a prod Worker without it refuses
  authenticated routes rather than silently fail-open. `WORKER_DEV_MODE=true`
  bypasses this for local work.
- **CORS denial**: when the allowlist is empty, the Worker echoes a
  guaranteed-invalid origin (`https://__actually_misconfigured__.invalid`)
  rather than `*` or `null` - browsers never match the response and operators
  see the value in DevTools.
- Per-IP rate limits on every authenticated route; global per-day cap on
  `/embeddings` to protect the operator's OpenAI bill. Both are enforced by
  `RateLimiterDO` (`worker/index.ts`), a Durable Object that does an atomic
  check-and-increment per counter - **fixed 2026-07-08**: the previous KV-based
  counter did a `get` then `put` with no atomicity guarantee, so concurrent
  requests could read the same stale count and both increment from it,
  letting a determined caller exceed the nominal limit by several times under
  concurrency. A Durable Object instance processes one request at a time
  (Cloudflare's platform guarantee), which closes that race without any extra
  locking code. **Requires the Workers Paid plan** (Durable Objects aren't
  available on Workers Free) - see `README.md` → "Deploy the Worker".

## Geo-fence posture (build-flag controlled)

Trading is gated on Polymarket-restricted jurisdictions via the Worker `/geo`
endpoint (`CF-IPCountry`).

- **Confirmed restricted** → wallet connect + order placement are ALWAYS
  blocked, regardless of any flag.
- **Unknown** (Worker misconfig, network error, 401/503, missing country) →
  behavior is governed by `GEO_FAIL_OPEN` (`VITE_GEO_FAIL_OPEN` at build time,
  see `src/shared/constants.ts`):
  - **fail-closed** (production default): wallet connect + order placement are
    paused until the region can be confirmed. This is the legally-conservative
    posture and is what a plain `vite build` ships.
  - **fail-open** (dev default, or `VITE_GEO_FAIL_OPEN=true`): trading proceeds
    with an inline warning. A flaky geo lookup won't break a beta cohort, and
    Polymarket still enforces its own jurisdiction block at order time.

Enforcement is defense-in-depth: both `connectWallet` and `placeOrder` in
`src/background/trade.ts` check independently, and the Trade tab UI blocks the
form before either is reached. The `geo_unknown` telemetry event measures how
often the lookup fails so the operator can monitor it.

## Extension permissions (v1)

- `permissions`: `storage`, `activeTab`, `alarms`, `scripting`, `offscreen`.
- `host_permissions`: `https://clob.polymarket.com/*` - required because the
  CLOB SDK posts signed orders directly. See `src/background/clob.ts` for
  the explicit "direct CLOB, not Worker proxy" decision and the v1.2 plan
  to move it behind the Worker.
- **No content scripts.** The popup reads the active tab on click via
  `chrome.scripting.executeScript` against the `activeTab` permission -
  the user-visible permission prompt stays minimal.

## CLOB credentials at rest

**Corrected 2026-07-20** (previous wording here overstated this): `clobApiKey` /
`clobApiSecret` / `clobApiPassphrase` / `wcSessionTopic` are stored in
`chrome.storage.local`, which is **not** encrypted by Chrome in any way that
resists another process on the same machine - it's plaintext JSON on disk in
the profile directory. Chrome's own docs recommend `storage.session`
(in-memory only, cleared on browser close) for genuinely sensitive data; see
developer.chrome.com/docs/extensions/reference/api/storage.

**Deliberately still `storage.local`, not moved to `storage.session`:**
these four fields don't grant fund-moving capability on their own. Every
individual order still needs a fresh EIP-712 signature from the connected
wallet via a live WalletConnect session (see `src/background/wallet.ts`) -
the CLOB API key/secret/passphrase only authenticate the HTTP layer of
`postOrder`/`cancelOrder`/position-read calls, the same pattern as any
exchange API key, and cannot themselves construct a new valid signed order.
Someone who reads these off disk could cancel the user's resting orders and
read their position history - a real but bounded privacy/griefing risk - not
sign or submit a new trade. Moving to `storage.session` would trade that
bounded risk for a real UX cost affecting every user, every session: no
wallet reconnect across a browser restart is exactly the friction the
WalletConnect fix (see `wallet.test.ts`) was built to avoid at launch.
Reaching the actual disk file also requires code execution as the same OS
user already - a threat model in which the browser's session cookies, saved
passwords, and every other extension's storage are equally exposed, so this
one field is not a uniquely weak link. Settings → Wallet's **Disconnect &
wipe** button clears all four fields; users should use it on shared devices.

`storage.setAccessLevel` (restricting `storage.local` to trusted contexts) is
not applicable here - it defends against a content script in the *same*
extension reading storage meant for the background/offscreen context, and
this extension registers zero `content_scripts` (see Permissions above).
Revisit if that ever changes.

## Network egress

The shipped CSP `connect-src` allows only:

- Cloudflare Worker host (production builds replace `*.workers.dev` with
  the exact host pinned via `VITE_WORKER_URL` - see `vite.config.ts`).
- `clob.polymarket.com`, `gamma-api.polymarket.com`, `data-api.polymarket.com`
  for market data and order routing.
- WalletConnect v2 relay hosts (`*.walletconnect.com`, `*.walletconnect.org`,
  `*.reown.com`, plus the matching wss:// entries).

`api.openai.com` is deliberately absent: the opt-in OpenAI embedding fallback
is called only server-side, by the Worker (which holds the key) - the
extension itself never sees the key and never contacts OpenAI directly, so
it has no reason to be in the extension's own CSP.

**v1.1 landed:** `huggingface.co`/`*.hf.co` (MiniLM-L12-v2 model weights) and
`cdn.jsdelivr.net` (`onnxruntime-web`'s default WASM binaries) are no longer
in CSP or fetched at runtime. `npm run models:fetch` (`scripts/fetch-model.mjs`)
downloads both into `public/models/` and `public/onnx/` at build time -
gitignored (too large to commit, ~34MB), so this must run before every build
(wired into CI, see `.github/workflows/ci.yml`). `src/background/embeddings.ts`
sets `env.allowRemoteModels = false` and points `localModelPath`/`wasmPaths`
at `chrome.runtime.getURL(...)`, so a missing bundled file fails loudly
instead of silently falling back to a network fetch. The extension is now
fully offline-installable after first load.

Fonts: the Google Fonts `@import` was removed. Fonts are fetched at install
time by `npm run fonts:fetch` and bundled into the .crx as woff2 files.

## Secret hygiene

- `.env.local` is gitignored; the only place real `VITE_WORKER_SECRET` and
  `VITE_WC_PROJECT_ID` live locally.
- `worker/wrangler.toml.example` ships with `REPLACE_WITH_KV_NAMESPACE_ID` /
  `REPLACE_WITH_EXTENSION_ID` placeholders - operators copy it to start.
  **Verified clean in this branch.**
- The real, tracked `worker/wrangler.toml` is *not* placeholder-only - it
  deliberately commits this project's actual `MARKET_CACHE` KV namespace id
  and `ALLOWED_EXTENSION_ID` (see `docs/release-checklist.md`'s "Do not strip
  `manifest.json`'s `key` field" section for why the extension ID is pinned
  and checked against this exact file by `npm run preflight`). Neither value
  is a secret: a KV namespace id grants no access without the Cloudflare
  account credentials, and the extension ID becomes public the moment the
  item is listed on the Chrome Web Store. `WORKER_SHARED_SECRET` and
  `OPENAI_API_KEY` are correctly absent from this file - they're set via
  `wrangler secret put`, never committed.
- `scripts/*.mjs` read URL + secret from `process.env`. None hardcode
  real values. **Verified clean in this branch.**

## npm audit triage

`npm audit` reports advisories largely in transitive deps. Honest breakdown:

- **Dev-only** (`rollup`, `undici`, `esbuild`, the `wrangler` / `ws` chain) -
  not present in the shipped extension.
- **Runtime, but low-risk given the input.** The `@xenova/transformers` →
  `onnxruntime-web` → `protobufjs` chain **is** exercised - it parses the local
  embedding model. The advisories concern malformed protobuf/ONNX input, but the
  only bytes we ever decode are the MiniLM-L12 weights, bundled into the .crx
  at build time by `npm run models:fetch` from the Hugging Face repo - not
  attacker-controlled, and (since v1.1) not even fetched at runtime. The
  `@ethersproject/*` signing primitives ship via `clob-client-v2`, but we sign
  exclusively through the user's wallet (WalletConnect), so those paths aren't hit.
- **`ws` (via `@walletconnect/jsonrpc-ws-connection` → `viem`), high severity -
  bundled but unreachable.** `npm run build` compiles this package's transport
  selection literally: `typeof self.WebSocket !== 'undefined' ? self.WebSocket
  : require('ws')` - verified present as a string in `dist/assets/offscreen-*.js`.
  The offscreen document always has a real `self.WebSocket` (it's a full DOM
  context, unlike a bare Node service worker), so the `require('ws')` branch
  never executes in the shipped extension; the vulnerable code ships as dead
  bytes, not a live code path. Re-check this reasoning if WalletConnect's
  transport-selection logic changes in an upstream bump.

No `npm audit fix --force` is applied because every "fix" is a breaking
downgrade of a runtime-critical dependency. Bundling the model weights into
the .crx at build time (shipped since v1.1) already keeps the Hugging Face
fetch out of the runtime attack surface; `scripts/fetch-model.mjs` additionally
pins the model to an exact HF commit (not `main`, a mutable ref) and verifies
each file's SHA-256 after download, so a future `npm run models:fetch` can't
silently bake in different bytes than what was reviewed - closing the actual
reachable risk (a supply-chain swap of the model file) even though the
protobufjs dependency itself remains unpatched upstream. The `ws` branch stays
dead code regardless since it's gated on an environment check, not a version
bump.

Re-triage when `clob-client-v2` ships an ethers v6 release or
`@xenova/transformers` v3 (server-side ONNX) lands.

## Reporting

Security issues: open a private GitHub Security Advisory on this repo.
