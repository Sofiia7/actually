# Chrome Web Store listing — copy pack (v1.0.0)

Ready-to-paste text for the CWS Developer Dashboard. Screenshots/promo images
still need the running extension (see shot list at the bottom).

---

## Item name
Actually — What Markets Really Think

## Summary (132 chars max)
Click any news story to see what prediction markets really think. Optional one-click trading via WalletConnect.

## Category
Productivity

## Detailed description
Reading the news and wondering what's actually likely to happen? Actually shows
you the real odds from Polymarket — the world's largest prediction market —
right on the page you're reading.

Click the toolbar icon on any news article. Actually reads the headline, matches
it against live prediction markets, and shows the market's probability,
color-coded by confidence. No account, no wallet, no signup — discovery is
completely free and private.

If you trade, connect any WalletConnect-compatible wallet to unlock a Trade tab:
7-day price trend, live orderbook, payout and slippage preview, and one-signature
limit or market orders on Polymarket.

• Free, private discovery — embeddings run locally on your device by default.
• No content scripts — the page is read only when you click, only the active tab.
• Optional trading — bring your own wallet; we never custody funds or keys.
• Open about attribution — orders you place are tagged with our builder code.

Actually does not provide financial advice. Prediction-market trading may be
restricted in your jurisdiction; Polymarket enforces its own regional rules.

## Single-purpose description (CWS requires this)
Show users what prediction markets are saying about the news they're reading,
and let them optionally trade on those markets in one click.

---

## Permission justifications (paste into the privacy tab)

- **activeTab + scripting** — On user click, read the headline and first ~500
  characters of the active tab to find a matching prediction market. Nothing is
  read in the background and no other tabs are accessed.
- **storage** — Save user settings, a local 10-item match history, the cached
  market list, and (if the user connects a wallet) their session locally.
- **alarms** — Schedule a periodic refresh of the cached market list.
- **offscreen** — Host the local embedding model (transformers.js / WASM), the
  WalletConnect session, and order signing, which MV3 service workers can't run.
- **host_permissions: https://clob.polymarket.com/** — Send the user's signed
  orders directly to Polymarket's order book when they place a trade.

## Data-use / privacy form answers
- "Does this item collect website content?" → **No** (only on click, only the
  active tab's headline + excerpt, used in-memory to match a market; not stored
  or transmitted as page content).
- "Personally identifiable / financial / health / authentication info?" → **No.**
- "Do you use remote code?" → **No.** The MiniLM-L12-v2 model weights and the
  onnxruntime-web WASM runtime are bundled into the package at build time
  (`npm run models:fetch`, see `SECURITY.md` → "Network egress") — no
  `eval()`, no remotely-hosted `.js`, and no runtime fetch to `huggingface.co`
  or `cdn.jsdelivr.net` (removed from CSP `connect-src` once bundled).
- "Is data sold to third parties / used for unrelated purposes / used for
  creditworthiness?" → **No** to all.
- Anonymous usage telemetry is opt-out in Settings and keyed by a random install
  id — no URLs, headlines, or wallet addresses (see docs/privacy-policy.md).

## Privacy policy URL
Host `docs/privacy-policy.md` (GitHub Pages or your domain) and paste the URL.

---

## Screenshot shot list (1280×800 PNG, ≥3)
1. Popup over a real news article — idle Check tab ("Check this page").
2. A match result card — question, YES %, volume, match %.
3. Trade tab (wallet connected) — sparkline + orderbook + Limit/Market ticket
   with payout + slippage rows.
4. (optional) History tab populated.
5. (optional) Settings → Wallet showing connected EOA + "Disconnect & wipe".

## Promotional images
- 440×280 small tile — text overlay readable at thumbnail size.
- 920×680 and 1400×560 marquee — crop the matched-market screenshot.
