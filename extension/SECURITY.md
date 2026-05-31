# Security notes

## Threat model — what "the Worker secret" actually protects

`WORKER_SHARED_SECRET` is baked into the production extension build via
`VITE_WORKER_SECRET` and shipped to every user. Because Vite inlines `VITE_*`
into the JS bundle, **anyone who installs the extension can extract this
value from the .crx in minutes**. Treat it as a public client token, not a
secret.

What this token does provide:

- Anti-accidental-load defense (random crawlers and one-off scripts that
  don't know to set `X-Actually-Auth` get a clean 401).
- A single rotation point if abuse spikes — bumping the secret + rebuilding
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
- **CORS denial**: when the allowlist is empty, the Worker echoes a
  guaranteed-invalid origin (`https://__actually_misconfigured__.invalid`)
  rather than `*` or `null` — browsers never match the response and operators
  see the value in DevTools.
- Per-IP rate limits on every authenticated route; global per-day cap on
  `/embeddings` to protect the operator's OpenAI bill.

## Extension permissions (v1)

- `permissions`: `storage`, `activeTab`, `alarms`, `scripting`, `offscreen`.
- `host_permissions`: `https://clob.polymarket.com/*` — required because the
  CLOB SDK posts signed orders directly. See `src/background/clob.ts` for
  the explicit "direct CLOB, not Worker proxy" decision and the v1.2 plan
  to move it behind the Worker.
- **No content scripts.** The popup reads the active tab on click via
  `chrome.scripting.executeScript` against the `activeTab` permission —
  the user-visible permission prompt stays minimal.

## CLOB credentials at rest

`clobApiKey` / `clobApiSecret` / `clobApiPassphrase` are stored in
`chrome.storage.local`, which Chrome encrypts at rest with the profile
keyring. Settings → Wallet shows a **Disconnect & wipe** button that
clears all four fields and the WalletConnect session topic. Users should
wipe on shared devices.

## Network egress

The shipped CSP `connect-src` allows only:

- Cloudflare Worker host (production builds replace `*.workers.dev` with
  the exact host pinned via `VITE_WORKER_URL` — see `vite.config.ts`).
- `clob.polymarket.com`, `gamma-api.polymarket.com`, `data-api.polymarket.com`
  for market data and order routing.
- `api.openai.com` (only used by the centralized embedding fallback, and
  only via the Worker — the extension itself never sees the OpenAI key).
- `huggingface.co` + `*.hf.co` — the `@xenova/transformers` model files
  are fetched on first use. **Planned v1.1**: bundle the MiniLM-L12-v2
  weights so this entry can be removed from CSP and the .crx becomes
  fully offline-deployable.
- WalletConnect v2 relay hosts (`*.walletconnect.com`, `*.walletconnect.org`,
  `*.reown.com`, plus the matching wss:// entries).

Fonts: the Google Fonts `@import` was removed. Fonts are fetched at install
time by `npm run fonts:fetch` and bundled into the .crx as woff2 files.

## Secret hygiene

- `.env.local` is gitignored; the only place real `VITE_WORKER_SECRET` and
  `VITE_WC_PROJECT_ID` live locally.
- `worker/wrangler.toml` ships with `REPLACE_WITH_KV_NAMESPACE_ID` /
  `REPLACE_WITH_EXTENSION_ID` placeholders. Operators copy `wrangler.toml.example`
  to start. **Verified clean in this branch.**
- `scripts/*.mjs` read URL + secret from `process.env`. None hardcode
  real values. **Verified clean in this branch.**

## npm audit triage

`npm audit` reports advisories largely in transitive deps that are either
dev-only (`rollup`, `undici`, `miniflare`, `ws`, `esbuild`) or in code paths
the extension does not exercise (`@ethersproject/*` signature primitives —
we sign exclusively via the user's wallet; ONNX proto decoding only over
trusted Hugging Face CDN). No `npm audit fix --force` is applied because
every "fix" is a breaking downgrade of a runtime-critical dependency.

Re-triage when `clob-client-v2` ships an ethers v6 release or
`@xenova/transformers` v3 (server-side ONNX) lands.

## Reporting

Security issues: open a private GitHub Security Advisory on this repo.
