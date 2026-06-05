import React from 'react';

export interface EtchedProps {
  children: React.ReactNode;
  size?: number;
  weight?: 200 | 300 | 400 | 500;
  italic?: boolean;
  family?: 'sans' | 'serif';
  color?: string;
  style?: React.CSSProperties;
}

/** Etched text — thin Inter / Instrument Serif, with a subtle white
 *  top highlight that suggests the glyphs are pressed into glass. */
export const Etched: React.FC<EtchedProps> = ({
  children,
  size = 14,
  weight = 300,
  italic = false,
  family = 'sans',
  color,
  style,
}) => (
  <span
    style={{
      fontFamily:
        family === 'serif'
          ? "'Instrument Serif', serif"
          : "'Inter', sans-serif",
      fontSize: size,
      fontWeight: weight,
      fontStyle: italic ? 'italic' : 'normal',
      letterSpacing: family === 'serif' ? '-0.005em' : '-0.012em',
      color: color || 'rgba(18,26,48,.82)',
      textShadow: '0 1px 0 rgba(255,255,255,.6)',
      ...style,
    }}
  >
    {children}
  </span>
);
