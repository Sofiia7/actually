# Actually - Popup (matte ice glass)

Drop-in React/TSX implementation of the popup design.

## Stack

- React 18 + TSX
- Inline styles for everything that depends on props (colors, padding, layout)
- One plain `styles.css` for things inline styles can't express:
  pseudo-elements (`.glass-btn:hover::before`), keyframe animations,
  data-URL SVG turbulence backgrounds, CSS mask gradients, the
  `--mx/--my/--frost-rgb` custom-property API.
- No Tailwind, no styled-components, no CSS Modules. Class names are
  global but namespaced (`glass-btn`, `frost-host`, `frost-needles`,
  `ice-crackle`, `matte-grain`, `thin-glass`, `label`).

## Files

```
popup_new/
├── README.md
├── styles.css              ← import once at popup root
├── fonts.css               ← Google Fonts (Inter / Instrument Serif / JetBrains Mono)
├── colors.ts               ← STOPS palette + rgbAt / tone / toneDark / frostRgb
├── components/
│   ├── Etched.tsx          ← typography wrapper
│   ├── GlassSurface.tsx    ← the popup chrome (matte frosted glass)
│   ├── GlassButton.tsx     ← flat-at-rest, convex-on-hover
│   ├── IceCard.tsx         ← rim-color market card with frost trail
│   ├── IcePlate.tsx        ← edge color vignette + crackle texture
│   ├── Tabs.tsx
│   ├── ProbDot.tsx
│   ├── PctChip.tsx
│   ├── LinkAction.tsx
│   ├── NeutralToggle.tsx
│   ├── ThinSlider.tsx
│   ├── NeutralScanner.tsx
│   └── Header.tsx
├── tabs/
│   ├── CheckTab.tsx        ← state: 'idle' | 'loading' | 'empty' | 'error' | 'success'
│   ├── TradeTab.tsx        ← state: 'loading' | 'empty' | 'error' | 'success'
│   ├── HistoryTab.tsx      ← state: 'loading' | 'empty' | 'success'
│   └── SettingsTab.tsx
├── Popup.tsx               ← composes Header + Tabs + active tab
└── index.tsx               ← demo entry: <BrowserChrome><FakeArticle/><Popup/></BrowserChrome>
```

## Usage

```tsx
import './fonts.css';
import './styles.css';
import { Popup } from './Popup';

<Popup />
```

Popup is fixed-width 360px. Mount it anywhere - it positions itself absolutely from its container's top/right by default; pass `style` to override.

## Design tokens

The palette lives in `colors.ts` as 5 RGB stops (deep-blue → blue → white →
red → deep-red, midpoint at 50%). Don't add greens, peaches or ambers -
the system is intentionally two-tone with white at the neutral point.

`frostRgb(pct)` is the cursor-trail tint (cold-blue / warm-red / white).
Currently the trail itself is uncolored - `--frost-rgb` is plumbed through
so you can re-enable temperature tint later if you want.

## Per-tab state contracts

```ts
type CheckState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty' }                                    // no match
  | { kind: 'error'; message: string }
  | { kind: 'success'; featured: Market; related: Market[] };

type TradeState =
  | { kind: 'loading' }
  | { kind: 'empty' }                                    // no suggestion yet
  | { kind: 'error'; message: string }
  | { kind: 'success'; suggestion: Suggestion };

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; items: HistoryItem[] };
```

## What's NOT included

- Real data fetching / Worker calls - pass results via props
- Persistence (settings live in local state for the demo only)
- Trade execution wiring
- i18n - strings are hard-coded English
