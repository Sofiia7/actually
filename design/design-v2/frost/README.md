# Frost-on-glass effect

Presentational only — **no app logic**, no dependencies. Drops onto any
glass panel and makes a static needle-frost crystal pattern "melt" into
view under the cursor (denser toward the panel edges), like wiping a
frozen window.

## Files
- `frost.css` — the `.frost-needles` layer + reveal rule.
- `frost.js`  — `buildFrostTexture()` (paints the pattern once → `--frost-tex`)
  and `attachFrostTracking(el)` (wires `--mx`/`--my` + `.is-tracking`).

## Plain HTML / JS
```html
<link rel="stylesheet" href="frost.css">
<script src="frost.js"></script> <!-- auto-builds the texture on load -->

<div class="frost-host" style="position:relative">
  <span class="frost-needles"><span class="frost-fill"></span></span>
  <!-- panel content -->
</div>

<script>
  document.querySelectorAll('.frost-host').forEach(el => Frost.attachFrostTracking(el));
</script>
```

## React / TSX
```tsx
import { useEffect, useRef } from 'react';
import './frost.css';
import { buildFrostTexture, attachFrostTracking } from './frost.js';

// once, app startup:
buildFrostTexture();

function GlassPanel({ children }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => attachFrostTracking(ref.current), []);
  return (
    <div ref={ref} className="frost-host" style={{ position: 'relative' }}>
      <span aria-hidden className="frost-needles"><span className="frost-fill" /></span>
      {children}
    </div>
  );
}
```
> The exported file is plain ESM/UMD JS. For a strict TS setup either rename
> to `frost.ts` (types are trivial — two functions returning `void`/cleanup)
> or add a small `.d.ts`. It touches **nothing** in `ops.ts` / `orderMath.ts`.

## Tuning knobs
| What | Where | Default |
|---|---|---|
| Frost intensity on hover | `frost.css` → `.is-tracking .frost-needles{ opacity }` | `.48` |
| "Melt" circle radius | `frost.css` → `.frost-needles` mask `135px 135px` | `135px` |
| Edge density falloff | `frost.css` → `.frost-fill` mask stops `.45/.8/#000` | — |
| Needle density | `frost.js` → `buildFrostTexture({ nuclei })` | `135` |
| Tile size / crispness | `buildFrostTexture({ tile, dpr })` | `300` / `2` |

## Notes
- `buildFrostTexture()` runs once and caches a PNG data-URL in `--frost-tex`;
  it's cheap and synchronous. Call again only if you want a fresh random
  pattern or different params.
- Needles are pure white with a faint cool glow so they read on cold glass.
- The cursor reveal (`.frost-needles`) and edge vignette (`.frost-fill`) are
  two **nested** masked elements, so their masks intersect naturally — no
  `mask-composite` needed (maximally compatible across browsers).
