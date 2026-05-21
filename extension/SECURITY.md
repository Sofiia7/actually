# Security notes

## npm audit triage

`npm audit` as of v2 reports ~27 advisories. All have been triaged below.
No `npm audit fix --force` is run because every "fix" is a breaking
downgrade of a runtime-critical dependency. The unfixed advisories are
either dev-only or in code paths we do not exercise.

### Runtime dependencies

| Package | Where it comes from | Real risk | Decision |
|---|---|---|---|
| `elliptic`, `@ethersproject/*` | `@polymarket/clob-client-v2` uses ethers v5 internally | Signature crypto. We do NOT derive keys in-extension — orders are signed by the user's wallet (MetaMask / WC v2) which uses its own crypto. clob-client-v2 only uses ethers to ENCODE the typed-data payload before forwarding to the signer. Affected primitives are not exercised. | Accept. Track upstream; bump when clob-client-v2 ships an ethers v6 release. |
| `protobufjs` → `onnx-proto` → `onnxruntime-web` → `@xenova/transformers` | Local embedding model | Protobuf decoding of model files downloaded from HuggingFace CDN. Risk is exposure if HF is compromised (broad-internet risk, not user-data risk). | Accept. Re-evaluate if we bundle the model in v1.x. |

### Dev-only dependencies (not shipped to users)

| Package | Source | Notes |
|---|---|---|
| `rollup` | `@crxjs/vite-plugin` | Build-time path traversal. No effect on shipped extension. |
| `undici`, `miniflare`, `ws` | `wrangler` | Local Worker dev server. No effect on production Worker (runs on CF runtime). |
| `esbuild` | Vite | Build-time. |

Run `npm audit` periodically and re-triage when an upgrade path opens
(e.g. clob-client-v2 ethers v6, transformers.js v3).

## Secret hygiene

- `WORKER_SHARED_SECRET` was rotated as part of the v2 audit (the old
  secret had been committed to scripts in the public repo).
- All build-time secrets live in `.env.local` which is gitignored.
- `wrangler.toml` is committed without real `account_id` or KV namespace
  `id` — operators fill these in locally or via env.

## Worker hardening

- Worker fails closed (503) if `WORKER_SHARED_SECRET` is unset, unless
  `WORKER_DEV_MODE=true` is explicitly set.
- Worker fails closed (503) if `ALLOWED_EXTENSION_ID` is unset (production).
- CORS does not echo `*` when the extension id is missing.

## Extension permissions

- `permissions`: `storage`, `activeTab`, `alarms`, `scripting`. No
  broad host permissions.
- `host_permissions`: `https://clob.polymarket.com/*` only — needed for
  the trading flow. Discovery does not hit any third-party host directly.
- No content scripts in the manifest. `chrome.scripting.executeScript`
  injects the article extractor on demand under `activeTab`.

## Reporting

Security issues: open a private GitHub Security Advisory on this repo.
