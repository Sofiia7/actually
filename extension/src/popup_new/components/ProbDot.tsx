import React from 'react';
import { rgbAt, rgba, toneDark } from '../colors';

export const ProbDot: React.FC<{ pct: number; size?: number }> = ({
  pct,
  size = 8,
}) => {
  const c = rgbAt(pct);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle at 30% 25%, rgba(255,255,255,.9) 0%, ${rgba(
          c,
          0.95,
        )} 60%, ${rgba(c, 1)} 100%)`,
        boxShadow: `0 0 6px ${rgba(c, 0.55)}, inset 0 0 0 .5px rgba(255,255,255,.55)`,
        display: 'inline-block',
        flex: '0 0 auto',
      }}
    />
  );
};

export const PctChip: React.FC<{ pct: number }> = ({ pct }) => (
  <span
    style={{
      fontFamily: 'Marck Script',
      fontSize: 12,
      fontWeight: 400,
      color: toneDark(pct, 0.92),
      textShadow: '0 1px 0 rgba(255,255,255,.6)',
      letterSpacing: '-0.01em',
    }}
  >
    {pct}%
  </span>
);
