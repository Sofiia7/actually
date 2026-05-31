# Actually — Privacy Policy

_Last updated: 2026-05-31_

Actually is a Chrome extension that shows Polymarket prediction-market odds for news articles, and lets users who connect a wallet place orders on those markets in one click. We aim to be as private as possible. This page explains exactly what data is collected, what is sent off your device, and why.

**Permission model:** the extension uses `activeTab` only — it can read the
content of the tab you are currently viewing **and only at the moment you
click the toolbar icon or press the hotkey**. It does not run a content
script on every page you visit; nothing happens until you act.

## What is processed on your device only

The following never leaves your device:

- **Your Worker URL and Worker secret** entered in Settings — stored in `chrome.storage.local`
- **Cached list of active Polymarket markets** (up to 300 entries, refreshed every 30 minutes)
- **Vector embeddings** for those market questions, used for matching news articles
- **Local history** of the last 10 articles you matched. Clear at any time from the History tab.
- **WalletConnect session topic** (once connected) and **Polymarket CLOB API credentials** (key, secret, passphrase) — used to authenticate order submissions. Never transmitted except to the CLOB itself.

The embedding model (`Xenova/all-MiniLM-L12-v2`, ~33 MB) is downloaded once from HuggingFace's CDN and cached by Chrome. Subsequent runs are fully offline for the local-embedding path.

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

## Anonymous telemetry (opt-out)

If you leave "Share anonymous usage stats" enabled in Settings (default on), the extension sends counters of the following events to our Worker:

`install`, `check_page_clicked`, `match_shown`, `match_lowconf`, `match_clicked`, `no_match`, `wallet_connect_started`, `wallet_connect_success`, `wallet_connect_failed`, `order_form_opened`, `order_signed`, `order_submitted`, `order_filled`, `order_failed`, `geo_blocked`, `cache_refresh`

Each event carries an anonymous `installId` (random UUID generated locally at first install) and may include **bucketed** metadata: confidence band (e.g. `0.6`), order size bucket (e.g. `50_200`), country code (only for `geo_blocked`), match color (`blue`/`yellow`/`red`).

What is **never** sent:
- URLs you visit
- Article headlines or content
- Wallet addresses (EOA or Safe)
- Order IDs or transaction hashes
- Polymarket usernames
- IP addresses (Cloudflare logs request IPs as standard infra; we do not query them)

Disable telemetry at any time in Settings.

## Third parties involved

| Party | When | What they see |
|---|---|---|
| Cloudflare Workers | All API calls | Request rate limiting, anonymous telemetry events |
| Polymarket (`gamma-api`, `clob`, `data-api`) | All discovery + trading | Public market data requests; signed order payloads (trading only) |
| OpenAI | Only if you switch to OpenAI embeddings | Article headline + body excerpt for embedding |
| WalletConnect / Reown | Only after you click Connect | WC relay handshake; never sees article content |
| HuggingFace CDN | First load of local model | Model file download (one time) |

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
