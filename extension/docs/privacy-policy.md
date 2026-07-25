# Actually — Privacy Policy

_Last updated: 2026-07-24_

Actually is a Chrome extension that shows Polymarket prediction-market odds for news articles, and lets users who connect a wallet place orders on those markets in one click. We aim to be as private as possible. This page explains exactly what data is collected, what is sent off your device, and why.

**Permission model:** the extension uses `activeTab` only — it can read the
content of the tab you are currently viewing **and only at the moment you
click the toolbar icon or press the hotkey**. It does not run a content
script on every page you visit; nothing happens until you act.

## What is processed on your device only

The following never leaves your device:

- **Your Worker URL and Worker secret** entered in Settings — stored in `chrome.storage.local`
- **Cached list of active Polymarket markets** (up to 800 entries, refreshed every 30 minutes)
- **Vector embeddings** for those market questions, used for matching news articles
- **Local history** of the last 10 articles you matched. Clear at any time from the History tab.
- **WalletConnect session topic** (once connected) and **Polymarket CLOB API credentials** (key, secret, passphrase) — used to authenticate order submissions. Never transmitted except to the CLOB itself.

The embedding model (`Xenova/all-MiniLM-L12-v2`, ~33 MB) and its WASM runtime are bundled into the extension package at build time — nothing is downloaded from HuggingFace or any other CDN at install or runtime. The local-embedding path is fully offline from the first run.

## What is sent off your device

Actually only sends data **when you act**.

### Discovery (works without a wallet)
When you click **Check this page**:
- The **headline and first 500 characters** of the active tab go through `chrome.scripting.executeScript` to the popup runtime. If you're on the local embedding provider (default), this text **never leaves your device**.
- If you opted into the OpenAI embedding provider in Settings, that text is forwarded through our Cloudflare Worker to OpenAI's `text-embedding-3-small` endpoint. Our Worker holds the OpenAI key — no per-user key is required.
- A read-only **market list** and **live price** lookup are fetched via our Worker, which proxies to `gamma-api.polymarket.com` and `clob.polymarket.com`.

When you click **View on Polymarket**, your browser opens the public Polymarket market URL with a `utm_source=actually` query parameter for our own funnel analytics. This is a standard UTM tag — no personal data is included.

### Trading (only if you connect a wallet)
When you click **Connect wallet** in the Trade tab:
- A **WalletConnect v2** session is initiated. WalletConnect's relay (operated by Reown / WalletConnect Cloud) sees an opaque connection request; it does not see article content.
- After approval, your **EOA address** (the public address of the wallet you connected) becomes known to the extension.
- We look up your **Polymarket Safe (funder) address** via our Worker `/clob/proxy/<eoa>` endpoint, which proxies `data-api.polymarket.com/wallet?user=<eoa>`. This is a public lookup using only your already-public EOA.
- A **CLOB API credential set** (key, secret, passphrase) is derived by signing a one-time message in your wallet. Stored locally; never re-transmitted off your device except to the Polymarket CLOB.

When you click **Place order**:
- The order payload (`tokenID`, `price`, `size`, `side`, our `builderCode`) is constructed in the popup, signed by your wallet via WalletConnect, and posted to `clob.polymarket.com`. Polymarket attributes the order's volume to our builder code, which is how this extension is monetized.
- A **country check** is performed via our Worker `/geo` endpoint (which reads Cloudflare's `CF-IPCountry` header). If your country is on Polymarket's restricted list, order submission is refused.

When you open the **Open Positions** panel or view your **resting orders**, your current positions and open orders are looked up via our Worker `/clob/positions/<safe-address>` endpoint (proxying `data-api.polymarket.com/positions`) and the CLOB API directly (for open orders, using your locally-held CLOB credentials) — a public lookup using only your already-known Safe address, mediated through our Worker like every other Polymarket data-api call.

## Pseudonymous telemetry (opt-in)

If you enable "Share anonymous usage stats" in Settings (**default off** — nothing is sent until you turn it on), the extension sends counters of the following events to our Worker:

`install`, `check_page_clicked`, `match_shown`, `match_lowconf`, `match_clicked`, `no_match`, `wallet_connect_started`, `wallet_connect_success`, `wallet_connect_failed`, `order_form_opened`, `order_signed`, `order_submitted`, `order_filled`, `order_failed`, `order_cancelled`, `order_cancel_failed`, `geo_blocked`, `geo_unknown`, `cache_refresh`

Each event carries a **pseudonymous** `installId` (a random UUID generated locally at first install, the same value on every event from your install — not a fresh anonymous value per event, so events from the same install can be linked to each other, just not to your real identity) and may include **bucketed** metadata: confidence band (e.g. `0.6`), order size bucket (e.g. `50_200`), country code (only for `geo_blocked`), match color (`blue`/`yellow`/`red`); `geo_unknown`'s `reason` is one of a small fixed set of causes (e.g. `network`, `rate_limited`, `misconfigured`) — never free text.

**Exception — failure reason text:** `order_failed` and `order_cancel_failed` additionally include a short `reason` string describing why the order/cancel failed — either a wallet/network error message or the raw rejection text returned by Polymarket's CLOB. This is not bucketed like the metadata above, and in rare cases a CLOB rejection message could reference the failed order's own id (e.g. `"order not found: 0x…"`). We do not otherwise collect or transmit order ids.

What is **never** sent:
- URLs you visit
- Article headlines or content
- Wallet addresses (EOA or Safe)
- Order IDs or transaction hashes, except where unavoidably embedded in a CLOB failure message as described above
- Polymarket usernames
- IP addresses (Cloudflare logs request IPs as standard infra; we do not query them)

Disable telemetry at any time in Settings.

## Third parties involved

| Party | When | What they see |
|---|---|---|
| Cloudflare Workers | All API calls | Request rate limiting, pseudonymous telemetry events (only if you opted in) |
| Polymarket (`gamma-api`, `clob`, `data-api`) | All discovery + trading | Public market data requests; signed order payloads (trading only) |
| OpenAI | Only if you switch to OpenAI embeddings | Article headline + body excerpt for embedding |
| WalletConnect / Reown | Only after you click Connect | WC relay handshake; never sees article content |

The local embedding model and its WASM runtime are bundled into the extension
itself (no HuggingFace/jsdelivr fetch at install or runtime) — article text
never leaves your device when using local embeddings (the default).

## Your rights

- Disable telemetry at any time in Settings
- Clear history at any time
- **Disconnect & wipe wallet** at any time — Settings → Wallet → the red
  button revokes the WC session and clears the stored CLOB API key, secret,
  passphrase, EOA, and Safe address from local storage
- Switch to fully-local embeddings (default) so article text never leaves your device
- Uninstall the extension, which deletes all local data

## Children

Actually is not directed at users under 18. Trading on Polymarket is age-restricted in many jurisdictions; see Polymarket's own terms.

## Contact

Open an issue at this repository, or email the address on the Chrome Web Store listing.
