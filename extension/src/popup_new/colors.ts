// =============================================================
// Probability color system. Two-tone with WHITE at midpoint:
//   0%   = deep saturated blue  (cold market - won't happen)
//  50%   = near-white             (uncertain)
// 100%   = deep saturated red    (hot market - will happen)
// No greens, peaches, ambers, creams. Just saturation.
// =============================================================

export type RGB = [number, number, number];
export interface Stop { p: number; c: RGB; }

export const STOPS: Stop[] = [
  { p:   0, c: [ 30,  95, 215] }, // deep blue
  { p:  25, c: [100, 165, 230] }, // blue
  { p:  50, c: [242, 246, 250] }, // near-white
  { p:  75, c: [220,  95, 100] }, // red
  { p: 100, c: [185,  35,  55] }, // deep red
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const rgbAt = (pct: number): RGB => {
  const p = Math.max(0, Math.min(100, pct));
  let i = 0;
  for (i = 0; i < STOPS.length - 1; i++) if (p <= STOPS[i + 1].p) break;
  const a = STOPS[i];
  const b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  const t = (p - a.p) / Math.max(1, b.p - a.p);
  return [
    Math.round(lerp(a.c[0], b.c[0], t)),
    Math.round(lerp(a.c[1], b.c[1], t)),
    Math.round(lerp(a.c[2], b.c[2], t)),
  ];
};

export const rgba = (rgb: RGB, a = 1) =>
  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

export const tone = (pct: number, a = 1) => rgba(rgbAt(pct), a);

/** Darkened tone for readable text. Near the white midpoint we
 *  fall back to neutral charcoal instead of dark gray. */
export const toneDark = (pct: number, a = 1) => {
  const c = rgbAt(pct);
  if (Math.abs(pct - 50) < 4) return `rgba(35,45,70,${a})`;
  return `rgba(${Math.round(c[0] * 0.45)},${Math.round(c[1] * 0.45)},${Math.round(c[2] * 0.45)},${a})`;
};

/** Tint hint for the cursor frost trail - currently unused (trail is
 *  pure white), but plumbed through `--frost-rgb` so you can re-enable
 *  temperature-tinted frost without touching CSS. */
export const frostRgb = (pct: number | null | undefined) => {
  if (pct == null) return '235,245,255';
  if (pct < 50) return '210,230,255';
  if (pct > 50) return '255,220,225';
  return '245,250,255';
};
