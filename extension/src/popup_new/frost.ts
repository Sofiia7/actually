/**
 * Frost-on-glass texture generator (presentational only — no app logic, no
 * deps). Paints a static needle-crystal pattern once to a canvas and exposes
 * it as the CSS var `--frost-tex`. The `.frost-fill` layer (styles.css) renders
 * it; `GlassSurface` reveals it under the cursor.
 *
 * Ported to typed ESM from the vanilla `frost.js` drop. The auto-build/global
 * wrapper was removed — call buildFrostTexture() explicitly at popup startup
 * (see src/popup/main.tsx). GlassSurface already does pointer tracking, so the
 * separate attachFrostTracking() helper from the drop is intentionally omitted.
 */
export interface FrostOptions {
  /** Logical tile size in px. */
  tile?: number
  /** Crispness multiplier (device-pixel-ratio style). */
  dpr?: number
  /** Number of crystal bursts scattered across the tile. */
  nuclei?: number
  /** CSS custom property to set the data-URL on. */
  cssVar?: string
  /** Element whose style receives the var (defaults to :root). */
  target?: HTMLElement
}

/**
 * Paint the needle-crystal pattern once and set `--frost-tex` (a PNG data-URL)
 * on the target element. Cheap and synchronous. Returns the data-URL, or null
 * if a 2D canvas context isn't available.
 */
export function buildFrostTexture(opts: FrostOptions = {}): string | null {
  const T = opts.tile ?? 300
  const dpr = opts.dpr ?? 2
  const N = opts.nuclei ?? 70
  const cssVar = opts.cssVar ?? '--frost-tex'
  const target = opts.target ?? document.documentElement

  const cv = document.createElement('canvas')
  cv.width = cv.height = T * dpr
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'

  // A single fine spicule: a thin ice needle with a couple of thinner barbs.
  function needle(x: number, y: number, ang: number, len: number, w: number, alpha: number): void {
    const x2 = x + Math.cos(ang) * len
    const y2 = y + Math.sin(ang) * len
    ctx!.strokeStyle = `rgba(95,112,140,${alpha})` // grey needle (tuned for the light popup)
    ctx!.lineWidth = w
    ctx!.beginPath()
    ctx!.moveTo(x, y)
    ctx!.lineTo(x2, y2)
    ctx!.stroke()
    const barbs = 2 + Math.floor(Math.random() * 3)
    for (let i = 1; i <= barbs; i++) {
      const t = i / (barbs + 1)
      const bx = x + (x2 - x) * t
      const by = y + (y2 - y) * t
      const bl = len * 0.28 * (1 - t)
      for (let s = -1; s <= 1; s += 2) {
        const a2 = ang + s * 0.7
        ctx!.lineWidth = w * 0.7
        ctx!.beginPath()
        ctx!.moveTo(bx, by)
        ctx!.lineTo(bx + Math.cos(a2) * bl, by + Math.sin(a2) * bl)
        ctx!.stroke()
      }
    }
  }

  // A burst = a radial starburst of needles from one nucleus.
  function burst(cx: number, cy: number): void {
    const spikes = 10 + Math.floor(Math.random() * 14)
    const base = Math.random() * Math.PI * 2
    for (let i = 0; i < spikes; i++) {
      const ang = base + (i / spikes) * Math.PI * 2 + (Math.random() - 0.5) * 0.35
      const len = 6 + Math.random() * 22
      needle(cx, cy, ang, len, 0.5 + Math.random() * 0.4, 0.55 + Math.random() * 0.35)
    }
  }

  // No per-stroke shadow: shadowBlur applied to tens of thousands of strokes
  // made generation take many seconds and froze the popup on open. Crisp grey
  // needles read fine on the light glass.

  // Scatter nuclei, each drawn across a 3×3 offset grid for seamless tiling.
  const offs = [-T, 0, T]
  for (let k = 0; k < N; k++) {
    const sx = Math.random() * T
    const sy = Math.random() * T
    for (let oi = 0; oi < 3; oi++) {
      for (let oj = 0; oj < 3; oj++) {
        burst(sx + offs[oi], sy + offs[oj])
      }
    }
  }

  // Fine sparkle dust between the crystals.
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(120,135,165,0.6)'
  for (let d = 0; d < 500; d++) {
    const r = Math.random() * 0.6 + 0.2
    ctx.beginPath()
    ctx.arc(Math.random() * T, Math.random() * T, r, 0, Math.PI * 2)
    ctx.fill()
  }

  const url = cv.toDataURL('image/png')
  target.style.setProperty(cssVar, `url("${url}")`)
  return url
}

/**
 * Set `--frost-tex`, reusing a cached texture when possible. Painting the
 * canvas on every popup open blocked first paint for seconds; instead we
 * generate it at most once, cache the data-URL in localStorage, and restore it
 * instantly on later opens. Bump the cache key to force a regenerate.
 */
const FROST_CACHE_KEY = 'actually:frostTex:v2'

export function ensureFrostTexture(opts: FrostOptions = {}): void {
  const cssVar = opts.cssVar ?? '--frost-tex'
  const target = opts.target ?? document.documentElement
  try {
    const cached = localStorage.getItem(FROST_CACHE_KEY)
    if (cached) {
      target.style.setProperty(cssVar, cached)
      return
    }
  } catch {
    /* localStorage unavailable — fall through and generate */
  }
  const url = buildFrostTexture(opts)
  if (url) {
    try {
      localStorage.setItem(FROST_CACHE_KEY, `url("${url}")`)
    } catch {
      /* quota / unavailable — the texture is already applied, just not cached */
    }
  }
}
