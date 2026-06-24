import React, { useEffect, useRef } from 'react';

export interface GlassSurfaceProps {
  children: React.ReactNode;
  radius?: number;
  style?: React.CSSProperties;
  /** Optional tint for the cursor frost trail. Currently unused —
   *  the trail is pure white. Keep this prop so consumers can opt
   *  into temperature-tinted frost later. */
  frostRgb?: string;
}

/**
 * The popup chrome. Near-invisible matte frosted glass — page behind
 * shows through almost completely; only the blur betrays the panel.
 * Tracks the global mouse position into CSS custom properties so the
 * `.frost-needles` overlay can render the crumpled-glass trail.
 */
export const GlassSurface: React.FC<GlassSurfaceProps> = ({
  children,
  radius = 12,
  style,
  frostRgb = '235,245,255',
}) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      el.style.setProperty('--mx', x + '%');
      el.style.setProperty('--my', y + '%');
      const inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      el.classList.toggle('is-tracking', inside);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div
      ref={ref}
      className="frost-host frost-host--chrome"
      style={{
        position: 'relative',
        borderRadius: radius,
        ['--frost-rgb' as any]: frostRgb,
        background: 'rgba(255,255,255,.045)',
        backdropFilter: 'blur(38px) saturate(108%)',
        WebkitBackdropFilter: 'blur(38px) saturate(108%)',
        border: '1px solid rgba(255,255,255,.22)',
        boxShadow:
          '0 18px 44px -22px rgba(15,25,55,.22), 0 4px 12px -8px rgba(15,25,55,.10)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <span aria-hidden className="matte-grain" />
      <span aria-hidden className="frost-needles">
        <span className="frost-fill" />
        <span className="frost-glow" />
      </span>
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
};
