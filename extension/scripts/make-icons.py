#!/usr/bin/env python3
"""
Render the extension icon set from the ProbDot, procedurally.

The icons were a scaffold placeholder - a flat solid-blue circle - until
2026-08-26. `extension/docs/icon-brief.md` argues, correctly, that the product
already owns a mark and a second one should not be invented: the ProbDot in
`src/popup_new/components/ProbDot.tsx`, a glossy sphere whose colour encodes a
market's probability on the blue -> white -> red ramp in `src/popup_new/colors.ts`.
The toolbar icon is that sphere, larger.

A static icon cannot show a live number, so it does not sit at one point on the
ramp - that would visually claim a probability. It carries the whole ramp across
the sphere: cold on the left, uncertain through the middle, hot on the right.

Why this is a script and not a hand-drawn asset: the ramp here is read from the
same five stops the UI renders, so the icon cannot drift away from the product by
someone editing one and not the other. Re-run it after changing `STOPS`.

Why Python: numpy and Pillow are already on this machine and there is no image
library anywhere in the npm tree. Nothing in the build depends on this script -
it writes PNGs and exits.

    python extension/scripts/make-icons.py

Writes extension/public/icon-{16,48,128}.png, a 1024 master for re-export, and a
400x400 logo for directories that ask for one (Cline's marketplace does).
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
ROOT = os.path.dirname(EXT)

# Mirrors STOPS in src/popup_new/colors.ts. Keep in sync.
STOPS = [
    (0.00, (30, 95, 215)),    # deep blue - cold, won't happen
    (0.25, (100, 165, 230)),
    (0.50, (242, 246, 250)),  # near-white - uncertain
    (0.75, (220, 95, 100)),
    (1.00, (185, 35, 55)),    # deep red - hot, will happen
]

SS = 2048          # supersampled render size
PAD = 0.08         # brief asks for ~8% padding so Chrome's rounded mask cannot crop the orb
LIGHT = np.array([-0.45, -0.55, 0.70])   # upper-left, toward the viewer
LIGHT = LIGHT / np.linalg.norm(LIGHT)
HILITE = (-0.40, -0.50)                  # 30% across, 25% down, as ProbDot renders it


def ramp(t):
    """STOPS lookup, vectorised. t in [0,1] -> float RGB.

    Each segment is eased with smoothstep rather than interpolated linearly. The
    UI does interpolate linearly, and it is right to: a 3px dot has no room to
    show a crease. Across a 128px sphere the derivative break at the near-white
    50% stop is very visible - it renders as a hard vertical seam splitting the
    orb in two, which reads as two half-balls glued together rather than one
    piece of glass. Easing costs nothing at the stops themselves, where the
    colours still match the UI exactly."""
    t = np.clip(t, 0.0, 1.0)
    out = np.zeros(t.shape + (3,), dtype=np.float64)
    for i in range(len(STOPS) - 1):
        p0, c0 = STOPS[i]
        p1, c1 = STOPS[i + 1]
        m = (t >= p0) & (t <= p1)
        if not m.any():
            continue
        f = (t[m] - p0) / (p1 - p0)
        f = (f * f * (3.0 - 2.0 * f))[:, None]
        out[m] = np.array(c0, float) * (1 - f) + np.array(c1, float) * f
    return out


def render(size=SS):
    r_px = size * (1 - 2 * PAD) / 2.0
    c = size / 2.0
    ys, xs = np.mgrid[0:size, 0:size]
    nx = (xs + 0.5 - c) / r_px
    ny = (ys + 0.5 - c) / r_px
    r2 = nx * nx + ny * ny
    r = np.sqrt(r2)
    inside = r2 <= 1.0

    nz = np.zeros_like(nx)
    nz[inside] = np.sqrt(1.0 - r2[inside])

    # The ramp is painted across the sphere rather than wrapped around it. A true
    # spherical wrap (longitude = asin(nx)) crushes both ends into thin rims and
    # leaves a mostly-white ball, which loses the cold-half/hot-half read the
    # brief needs to survive at 16px.
    # Tilted a little off vertical. A perfectly upright divide reads as a flag
    # painted on a ball; a slight lean reads as something inside the glass.
    ang = np.radians(14.0)
    axis = nx * np.cos(ang) + ny * np.sin(ang)
    col = ramp((axis + 1.0) / 2.0)

    # Diffuse term, deliberately shallow: the ramp is the subject, the shading
    # only has to say "sphere".
    ndotl = np.clip(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0, 1)
    shade = 0.74 + 0.40 * ndotl
    col *= shade[..., None]

    # Limb darkening, so the edge reads as curvature and not as a cut-out disc.
    col *= (0.82 + 0.18 * np.power(np.clip(nz, 0, 1), 0.6))[..., None]

    # Glossy hotspot: a broad bloom with a tighter core inside it.
    dh = np.sqrt((nx - HILITE[0]) ** 2 + ((ny - HILITE[1]) * 1.25) ** 2)
    spec = 0.50 * np.exp(-((dh / 0.42) ** 2)) + 0.30 * np.exp(-((dh / 0.20) ** 2))
    spec = np.clip(spec, 0, 1)[..., None]
    col = col * (1 - spec) + 255.0 * spec

    # Inner rim light, weighted toward the side away from the key light, which is
    # where a glass ball picks up its surroundings.
    ring = np.exp(-(((1.0 - r) / 0.055) ** 2))
    back = np.clip(-(nx * LIGHT[0] + ny * LIGHT[1]), 0, 1)
    rim = np.clip(ring * (0.30 + 0.70 * back) * 0.55, 0, 1)[..., None]
    col = col * (1 - rim) + 250.0 * rim

    rgb = np.clip(col, 0, 255)
    alpha = np.where(inside, 255.0, 0.0)

    # Faint coloured glow behind the orb. Kept low so the icon still reads as a
    # sphere on a transparent background rather than a blurred blob.
    outer = (~inside) & (r < 1.30)
    if outer.any():
        g = 0.16 * np.exp(-(((r[outer] - 1.0) / 0.075) ** 2))
        gc = ramp((axis[outer] + 1.0) / 2.0) * 0.85
        rgb[outer] = gc
        alpha[outer] = np.clip(g, 0, 1) * 255.0

    img = np.dstack([rgb, alpha[..., None]]).astype(np.uint8)
    return Image.fromarray(img, "RGBA")


def contrast_report(im):
    """The brief asks that the two ends stay distinguishable in greyscale, because
    Chrome desaturates icons for disabled tabs. The palette makes the endpoints
    themselves nearly equal in luminance (deep blue 89, deep red 82 out of 255),
    so what actually carries the read is the bright middle band plus the key
    light. This prints what the rendered icon really does."""
    a = np.asarray(im.convert("RGBA"), dtype=float)
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    solid = a[..., 3] > 200
    h, w = lum.shape
    third = w // 3
    left = lum[:, :third][solid[:, :third]]
    mid = lum[:, third:2 * third][solid[:, third:2 * third]]
    right = lum[:, 2 * third:][solid[:, 2 * third:]]
    print("  greyscale means - cold %.0f | middle %.0f | hot %.0f" % (left.mean(), mid.mean(), right.mean()))
    print("  middle stands off the ends by %.0f and %.0f" % (mid.mean() - left.mean(), mid.mean() - right.mean()))
    print("  cold vs hot differ by %.0f" % abs(left.mean() - right.mean()))


def main():
    master = render(SS)
    targets = [
        (os.path.join(EXT, "public", "icon-16.png"), 16),
        (os.path.join(EXT, "public", "icon-48.png"), 48),
        (os.path.join(EXT, "public", "icon-128.png"), 128),
        (os.path.join(EXT, "docs", "promo", "icon-master-1024.png"), 1024),
        (os.path.join(ROOT, "marketing", "store", "logo-400.png"), 400),
    ]
    for path, size in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        master.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
        print("wrote %-52s %dx%d" % (os.path.relpath(path, ROOT), size, size))
    print("16px legibility check:")
    contrast_report(master.resize((16, 16), Image.LANCZOS))


if __name__ == "__main__":
    main()
