# Enabling in-app redeem (relayer credentials)

Redeeming a resolved position is the one action that does not go through the
CLOB. It is an on-chain call made **as the user's Polymarket Safe**, submitted
through Polymarket's relayer so nobody needs POL for gas. The relayer
authenticates `POST /submit`, and without credentials it answers
`401 {"error":"invalid authorization"}` — which is exactly what in-app redeem
did on every attempt until 2026-08-17.

The relayer accepts **two credential schemes**, and this project supports both:

| | Relayer API key | Builder API key |
|---|---|---|
| Parts | `key` + owning `address` | `key` + `secret` + `passphrase` |
| Auth | two static headers | HMAC signature per request |
| Scope | the account that created it | the builder profile |
| Where | Settings → **API Keys** → Relayer API Keys | builder program (HMAC triple) |
| Secret leaves the Worker? | yes (the key IS the header) | no (only a signature does) |

**Neither is the builder *code*.** The builder code (already baked into both
clients) attributes CLOB orders and is public by design.

## Quick path — Relayer API key (what the settings UI hands out)

1. polymarket.com → Settings → **API Keys** → Relayer API Keys → create.
2. Copy the **API key** and the **signer address** shown with it.
3. From the `extension/` directory:

```bash
npx wrangler secret put RELAYER_API_KEY --config worker/wrangler.toml
npx wrangler secret put RELAYER_API_KEY_ADDRESS --config worker/wrangler.toml
```

Scope caveat: a relayer key authorizes gasless operations **for the account
that created it**. For the operator redeeming their own positions (and for
pre-launch testing, where the operator is the only user) that is exactly
right. Whether it authorizes submits for *other* users' Safes is not
documented — if it doesn't, arbitrary users of a published extension will
still get 401s, and launch needs the builder scheme below.

Security caveat: in remote-signer flow the client receives the headers to
attach, so with this scheme the key itself transits to the extension.
Holding it cannot move funds — every submit still needs the user's own Safe
signature — but it can read the owner's relayer transactions and burn rate
limit. Fine while the only client is your own unpublished build; prefer
builder credentials for public launch. When both are configured, the Worker
automatically prefers builder HMAC.

## Launch path — Builder API credentials (HMAC triple)

If/when you hold a `key` / `secret` / `passphrase` triple from the builder
program (docs: "Settings → Builders → + Create New"; the current UI may only
show relayer-style keys — ask in the builder Telegram/builder@polymarket.com
if the triple isn't visible):

```bash
npx wrangler secret put BUILDER_API_KEY --config worker/wrangler.toml
npx wrangler secret put BUILDER_API_SECRET --config worker/wrangler.toml
npx wrangler secret put BUILDER_API_PASSPHRASE --config worker/wrangler.toml
```

The default *Unverified* tier allows **100 relayer transactions per day**,
which is also the ceiling this Worker enforces on itself. *Verified*
(10,000/day) is a manual upgrade via builder@polymarket.com.

> Run wrangler from `extension/`, not from `extension/worker/`. Wrangler 4.12x
> resolves config against the nearest workspace package and will otherwise
> deploy `dist/` as a static site under the wrong name — and silently edit
> vite.config.ts/package.json while at it (both happened here).
>
> `extension/package.json`'s wrangler scripts all pass `--config
> worker/wrangler.toml` for this reason; `npm run worker:deploy` is the safe
> way in. Verified with `--dry-run`: the invocation resolves the Worker and
> leaves the extension's build config alone.

## Confirm

```bash
curl -s -H "X-Actually-Auth: $WORKER_SECRET"   https://actually-api.sofiaseremeteva.workers.dev/builder-status
```

`{"configured":true,"mode":"relayer"}` (or `"builder"`) means the extension
starts offering **Redeem →** on resolved positions instead of "Claim on
Polymarket →". No rebuild, no release — the UI asks the Worker at runtime
(cached for 5 minutes).

For the MCP server, which runs on the operator's own machine, the same
credentials go into the environment directly — relayer scheme:

```
POLYMARKET_RELAYER_API_KEY=...
POLYMARKET_RELAYER_API_KEY_ADDRESS=...
```

or builder scheme: `POLYMARKET_BUILDER_API_KEY` / `_SECRET` / `_PASSPHRASE`.

## What the Worker does

`POST /builder-sign` takes `{method, path, body}` and returns the auth
headers for the configured scheme. Beyond the shared secret,
extension-origin allowlist and per-IP limits every route already has:

- it only signs for `/submit` and `/transactions` — an open-ended signer
  would hand the credential's full reach to anyone holding the
  (deliberately public) client secret;
- a **100 signatures/day** ceiling, matching the Unverified tier's entire
  allowance, so exhausting the quota cannot happen quietly;
- in HMAC mode, the timestamp is stamped by the Worker, never taken from the
  caller.

## Verifying a live redeem afterwards

Redeem is the only path where a bug means real money stuck rather than a
rejected order, and it has never completed successfully. Test it once with a
small resolved position and confirm the payout lands in the Polymarket
balance.
