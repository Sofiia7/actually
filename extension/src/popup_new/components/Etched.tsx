import React from 'react';

export interface EtchedProps {
  children: React.ReactNode;
  size?: number;
  weight?: 200 | 300 | 400 | 500;
  /** Kept for API compat — Marck Script is already a cursive script, so we
   *  never apply CSS italic on top of it (would render as a fake oblique). */
  italic?: boolean;
  family?: 'sans' | 'serif';
  color?: string;
  style?: React.CSSProperties;
}

/** Etched text — Marck Script throughout, with a subtle white top
 *  highlight that suggests the glyphs are pressed into glass.
 *  `weight` and `italic` are kept on the props for caller compat but
 *  don't change rendering — Marck Script ships as a single style. */
export const Etched: React.FC<EtchedProps> = ({
  children,
  size = 14,
  color,
  style,
}) => (
  <span
    style={{
      fontFamily: "'Marck Script', cursive",
      fontSize: size,
      fontWeight: 400,
      fontStyle: 'normal',
      letterSpacing: '-0.005em',
      color: color || 'rgba(18,26,48,.82)',
      textShadow: '0 1px 0 rgba(255,255,255,.6)',
      ...style,
    }}
  >
    {children}
  </span>
);
