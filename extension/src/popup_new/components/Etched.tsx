import React from 'react';

export interface EtchedProps {
  children: React.ReactNode;
  size?: number;
  weight?: 200 | 300 | 400 | 500;
  /** Kept for API compat — unused: the system UI font stack renders italic
   *  fine, but nothing in this design currently calls for it. */
  italic?: boolean;
  family?: 'sans' | 'serif';
  color?: string;
  style?: React.CSSProperties;
}

/** Etched text — system UI font throughout, with a subtle white top
 *  highlight that suggests the glyphs are pressed into glass. `weight`
 *  is a real variable-weight axis on this font stack (unlike the prior
 *  single-style cursive), so it now actually renders. */
export const Etched: React.FC<EtchedProps> = ({
  children,
  size = 14,
  weight = 400,
  color,
  style,
}) => (
  <span
    style={{
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      fontSize: size,
      fontWeight: weight,
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
