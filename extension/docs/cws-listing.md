# Chrome Web Store listing - copy pack (v1.0.0)

Ready-to-paste text for the CWS Developer Dashboard. Screenshots and promo
images are built and ready in `marketing/store/` - see its README for which
file goes where, and for the one judgement call left open.

---

## Item name
Actually - What Markets Really Think

## Summary (132 chars max)
Click any news story to see what prediction markets really think. Optional one-click trading via WalletConnect.

## Category
Productivity

## Detailed description
Reading the news and wondering what's actually likely to happen? Actually shows
you the real odds from Polymarket - the world's largest prediction market -
right on the page you're reading.

Click the toolbar icon on any news article. Actually reads the headline, matches
it against live prediction markets, and shows the market's probability,
color-coded by confidence. No account, no wallet, no signup - discovery is
completely free and private.

Reading the news in Russian, Spanish, German or anything else? Actually
translates the page into English before matching, because every Polymarket
question is written in English. It uses your browser's own built-in translator
(Chrome 138+ on desktop), so the text never leaves your device and no extra
permission is asked for. If your browser has no built-in translator, the check
runs on the original text and the popup tells you so rather than leaving you
to wonder why nothing matched.

If you trade, connect any WalletConnect-compatible wallet to unlock a Trade tab:
7-day price trend, live orderbook depth, payout and slippage preview, and
one-signature limit or market orders on Polymarket - plus see your open
positions and cancel resting orders without leaving the page.

• Free, private discovery - embeddings run locally on your device by default.
• Works on non-English news - translated on-device, nothing uploaded.
• No content scripts - the page is read only when you click, only the active tab.
• Optional trading - bring your own wallet; we never custody funds or keys.
• Open about attribution - orders you place are tagged with our builder code.

Actually does not provide financial advice. Prediction-market trading may be
restricted in your jurisdiction; Polymarket enforces its own regional rules.

## Single-purpose description (CWS requires this)
Show users what prediction markets are saying about the news they're reading,
and let them optionally trade on those markets in one click.

---

## Permission justifications (paste into the privacy tab)

- **activeTab + scripting** - On user click, read the headline and first ~500
  characters of the active tab to find a matching prediction market. Nothing is
  read in the background and no other tabs are accessed.
- **storage** - Save user settings, a local 10-item match history, the cached
  market list, and (if the user connects a wallet) their session locally.
- **unlimitedStorage** - The cached market list holds ~2000 markets with their
  precomputed embeddings (~7 MB), which exceeds `storage.local`'s 10 MB default
  once settings and history sit alongside it. Nothing is uploaded; this only
  raises the local cache ceiling.
- **alarms** - Schedule a periodic refresh of the cached market list.
- **offscreen** - Host the local embedding model (transformers.js / WASM), the
  WalletConnect session, and order signing, which MV3 service workers can't run.
- **host_permissions** - three hosts, all Polymarket trading paths. The
  manifest declares all three, so all three have to be justified here:
  - `https://clob.polymarket.com/` - send the user's signed orders directly to
    Polymarket's order book when they place a trade.
  - `https://relayer-v2.polymarket.com/` - submit the gasless on-chain claim
    when the user redeems a resolved position, so they need no POL for gas.
  - `https://polygon.drpc.org/` - the Polygon RPC endpoint used to read back
    that transaction's state. It is viem's default RPC for the Polygon chain,
    reached by the relayer client; no user data is sent to it.

## Data-use / privacy form answers

The CWS dashboard's privacy tab is a series of yes/no checkboxes per data
category, not free text - check exactly these boxes (verified against
actual code behavior 2026-07-17, not just the intended design):

- **"Website content"** → **Yes.** Only when the user opts into the OpenAI
  embedding provider in Settings (default is **local, on-device** - this is
  off by default and most users never trigger it): the active tab's headline
  + up to 500 characters are sent to our Worker, which forwards them to
  OpenAI to compute an embedding, then discards them. Never stored, never
  used for anything but that one match. State this qualifier in the
  dashboard's free-text justification field if it offers one.
- **"User activity"** → **Yes.** Pseudonymous usage telemetry (which UI
  element was clicked, order submitted/failed, etc.) is **opt-in** - off by
  default, nothing sent until the user enables it in Settings - and keyed by
  a random per-install id (the same id across that install's events, not a
  fresh one per event - hence pseudonymous, not anonymous). No URLs,
  headlines, or wallet addresses are included (see `docs/privacy-policy.md`
  for the exact event list). This is the category Google defines as "clicks
  and interaction within the extension" - it applies regardless of the
  opt-in default or how pseudonymous the payload is.
- **Personally identifiable / financial / health / authentication /
  location / web history info** → **No** to all - none of these are
  collected in any code path.
- **Translation is not a data-collection category here, and it is worth saying
  why before a reviewer wonders.** Non-English pages are translated before
  matching via the browser's own `Translator` API (Chrome 138+). That runs
  on-device: the extension makes no network call for it, sends the text to no
  service of ours or anyone else's, and needs no permission. Chrome may
  download a language pack from Google the first time a pair is used, which is
  the browser's own traffic, not the extension's.
- **"Do you use remote code?"** → **No.** The MiniLM-L12-v2 model weights and
  the onnxruntime-web WASM runtime are bundled into the package at build time
  (`npm run models:fetch`, see `SECURITY.md` → "Network egress") - no
  `eval()`, no remotely-hosted `.js`, and no runtime fetch to `huggingface.co`
  or `cdn.jsdelivr.net` (removed from CSP `connect-src` once bundled).
- **"Is data sold to third parties / used for purposes unrelated to the
  item's core functionality / used to determine creditworthiness or for
  lending"** → **No** to all three certification checkboxes - telemetry and
  the opt-in OpenAI path both exist solely to run the extension's stated
  single purpose, and OpenAI/Cloudflare are processors of that data, not
  buyers of it.

Getting "Website content" and "User activity" wrong here (i.e. leaving them
at "No") is a real compliance risk, not a formality: Google's review can
reject the listing or take it down post-publication if the declared
categories don't match observed behavior, and both of ours were previously
marked "No" while the code does collect them.

## Privacy policy URL
https://actually-api.sofiaseremeteva.workers.dev/privacy

Served by the Worker straight from `docs/privacy-policy.md` (imported as a
text module), so the published page cannot drift from the file in this repo.
Public, no auth - a reviewer arrives without a credential.

---

## Screenshot shot list (1280×800 PNG, ≥3)
1. Popup over a real news article - idle Check tab ("Check this page").
2. A match result card - question, YES %, volume, match %.
3. Trade tab (wallet connected) - sparkline + orderbook depth + Limit/Market
   ticket with payout + slippage rows.
4. Open positions & resting orders panel - cost basis/P&L and an in-app
   Cancel on a resting order.
5. (optional) A non-English article matched - the popup shows what it
   translated from, which is the only way a screenshot proves the feature.
6. (optional) History tab populated.
7. (optional) Settings → Wallet showing connected EOA + "Disconnect & wipe".

## Promotional images
- 440×280 small tile - text overlay readable at thumbnail size.
- 920×680 and 1400×560 marquee - crop the matched-market screenshot.
