# Enabling in-app redeem (Builder API credentials)

Redeeming a resolved position is the one action that does not go through the
CLOB. It is an on-chain call made **as the user's Polymarket Safe**, submitted
through Polymarket's relayer so nobody needs POL for gas. The relayer
authenticates `POST /submit` with **Builder API credentials**, and without them
it answers `401 {"error":"invalid authorization"}` — which is exactly what
in-app redeem did on every attempt until 2026-08-17.

**This is not the builder code.** The builder *code* (already baked into both
clients) attributes CLOB orders to us and is public by design. The builder
*API credentials* are a `key` / `secret` / `passphrase` triple that
authenticates requests, and they are a real secret.

## Step 1 — create the credentials (2 minutes, no approval needed)

1. Open <https://polymarket.com/settings?tab=builder> with the builder account.
2. If there is no builder profile yet, create one.
3. Click **"+ Create New"** to generate API keys.
4. Copy the **key**, **secret** and **passphrase**. The secret is shown once.

The default *Unverified* tier allows **100 relayer transactions per day**,
which is also the ceiling this Worker enforces on itself. Raising it means
emailing builder@polymarket.com for *Verified* (10,000/day) with the builder
API key, a use-case description and expected volume.

## Step 2 — give them to the Worker (never to the extension)

The extension cannot hold this secret: every install would carry it in
plaintext, and anyone extracting it could spend the whole daily quota. So the
Worker signs each request instead — the "remote signer" mode Polymarket's own
`@polymarket/builder-signing-sdk` supports.

```bash
cd extension
npx wrangler secret put BUILDER_API_KEY --config worker/wrangler.toml
npx wrangler secret put BUILDER_API_SECRET --config worker/wrangler.toml
npx wrangler secret put BUILDER_API_PASSPHRASE --config worker/wrangler.toml
```

Each command prompts for the value and stores it encrypted at Cloudflare.

> Run wrangler from `extension/`, not from `extension/worker/`. Wrangler 4.12x
> resolves config against the nearest workspace package and will otherwise
> deploy `dist/` as a static site under the wrong name.

## Step 3 — confirm

```bash
curl -s -H "X-Actually-Auth: $WORKER_SECRET" \
  https://actually-api.sofiaseremeteva.workers.dev/builder-status
```

`{"configured":true}` means the extension will start offering **Redeem →** on
resolved positions instead of "Claim on Polymarket →". No rebuild and no new
release are needed — the UI asks the Worker at runtime (cached 5 minutes).

For the MCP server, which runs on the operator's own machine and already holds
a private key, the same credentials go in the environment directly:

```
POLYMARKET_BUILDER_API_KEY=...
POLYMARKET_BUILDER_API_SECRET=...
POLYMARKET_BUILDER_API_PASSPHRASE=...
```

## What the Worker does with them

`POST /builder-sign` takes `{method, path, body}` and returns the four
`POLY_BUILDER_*` headers. Beyond the shared secret, extension-origin allowlist
and per-IP limits every route already has, it adds two of its own:

- it will only sign for `/submit` and `/transactions` — the credential can
  authenticate any relayer route, and an open-ended signer would hand that
  reach to anyone holding the (deliberately public) client secret;
- a **100 signatures/day** ceiling, matching the tier's entire allowance, so
  exhausting the quota cannot happen quietly.

The timestamp is stamped by the Worker, never taken from the caller: the
relayer checks it against its own clock, so a skewed or replayed value is
just a rejected signature.

## Verifying a live redeem afterwards

Redeem is the only path where a bug means real money stuck rather than a
rejected order, and it has never completed successfully. Test it once with a
small resolved position and confirm the payout lands in the Polymarket
balance.
