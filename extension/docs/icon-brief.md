# Icon brief — replacing the placeholder

`extension/public/icon-{16,48,128}.png` are currently a flat solid-blue
circle with no detail — a scaffold placeholder that was never replaced (see
`actually-tomorrow-checklist.md`). This is the one visible gap in an
otherwise CWS-ready listing. This brief is enough to hand to a designer, a
freelancer, or an image-generation tool, without them needing to read the
codebase.

## Concept: it's the ProbDot, not a new logo

Don't invent new brand iconography — the product already has one, rendered
on every match card in the popup (`src/popup_new/components/ProbDot.tsx`): a
small glossy sphere whose color encodes a market's probability on a
blue → white → red gradient (cold = won't happen, hot = will happen — the
codebase literally calls this the "ice" system: `IcePlate`, `IceCard`,
`frostRgb`). The toolbar icon should be **that same sphere, larger**, so a
user who has the popup open recognizes the toolbar icon as "the same thing,
zoomed in" rather than a disconnected logo bolted on afterward.

Concretely: a single glossy orb, lit from the upper-left, rendered as if
made of frosted/translucent glass (cold material, not plastic or metal) —
matching the "ice" naming throughout the codebase. Not a flat circle, not a
gradient square, not a magnifying glass, not a chart/candlestick icon, not a
dollar sign, not a bull/bear silhouette — none of those describe what the
product actually does (map news text → a market's probability).

## Exact palette — reuse these, don't reinterpret

Source: `extension/src/popup_new/colors.ts` (`STOPS`). These are the only
colors the product ever renders a probability in; the icon must use the
same ramp so it reads as the same system, not a coincidentally similar one.

| Stop | Hex | RGB | Meaning |
|---|---|---|---|
| 0% | `#1E5FD7` | 30, 95, 215 | deep blue — cold, won't happen |
| 25% | `#64A5E6` | 100, 165, 230 | blue |
| 50% | `#F2F6FA` | 242, 246, 250 | near-white — uncertain |
| 75% | `#DC5F64` | 220, 95, 100 | red |
| 100% | `#B92337` | 185, 35, 55 | deep red — hot, will happen |

A static app icon can't show a live number, so don't pick one point on the
ramp (that would visually claim a specific probability). Instead render the
**full ramp across the sphere** — deep blue on one side blending through
near-white to deep red on the other, like a small marbled/agate glass orb —
so the icon reads as "the probability spectrum itself," not one reading of
it. `ProbDot.tsx`'s existing highlight recipe is a good starting point for
the glossy hotspot: a soft white highlight around 30% across / 25% down,
fading into the base color, plus a faint colored glow behind the sphere and
a thin near-white inner rim light — reuse that treatment rather than a flat
Bootstrap-style gradient circle.

## What must survive at each size

- **16×16 (toolbar):** only the silhouette and the blue→red split need to
  read — no highlight detail will survive this small. Make sure the two
  ends of the gradient are still distinguishable as "a cold half and a hot
  half" even fully desaturated (test in grayscale — Chrome's disabled-tab
  state renders icons desaturated).
- **48×48:** the glossy highlight becomes visible; the sphere should read as
  glass/liquid, not a flat sticker.
- **128×128 (Web Store listing + `chrome://extensions`):** full detail —
  highlight, faint ambient glow, subtle rim light. This is the one a CWS
  reviewer and every install-prompt screen actually sees at full size, so it
  carries the most weight.

## Deliverables

- One master vector (SVG or a high-res PNG ≥512×512) so it can be re-exported
  cleanly if sizes change later.
- Exported PNGs at exactly **16×16, 48×48, 128×128**, transparent background,
  replacing `extension/public/icon-16.png` / `icon-48.png` / `icon-128.png`
  1:1 (same filenames — `manifest.json` already points at these paths, no
  code change needed).
- Leave ~8% padding on all sides at 128×128 so the sphere isn't cropped
  edge-to-edge (matches how Chrome renders extension icons with a rounded
  clipping mask on some surfaces).
- Reuse the same mark, cropped/composed as needed, for the Chrome Web Store
  promo tiles already scoped in `extension/docs/cws-listing.md` (440×280
  small tile, 920×680 and 1400×560 marquee) — these are the other still-open
  item from that doc, and sharing one source asset keeps them consistent
  instead of commissioning a second unrelated design.

## After you have the files

Drop them into `extension/public/`, then:

```bash
cd extension
npm run build
npm run preflight   # re-checks manifest/dist wiring, does not itself detect "is this a placeholder"
npm run smoke
```

`preflight`/`smoke` only check that the icon files exist and are wired up
correctly — they can't tell a real icon from a placeholder, so a visual
check (`chrome://extensions` → Load unpacked → `dist/`) is still worth doing
once before submission.
