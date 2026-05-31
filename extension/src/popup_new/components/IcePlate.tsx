import React from 'react';
import { rgbAt, rgba } from '../colors';

/**
 * The crystalline plate background for a market card.
 * Color sits at the rim (radial vignette inward); the centre is
 * clear glass. A turbulence layer adds the crystalline texture.
 * Matches the textured-glass-plate reference photos.
 */
export const IcePlate: React.FC<{ pct: number; intensity?: number }> = ({
  pct,
  intensity = 1,
}) => {
  const c = rgbAt(pct);
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {/* Symmetric rim color, dense at edge → transparent in middle */}
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          background: `radial-gradient(120% 140% at 50% 50%,
            transparent 0%,
            ${rgba(c, 0.04 * intensity)} 38%,
            ${rgba(c, 0.18 * intensity)} 70%,
            ${rgba(c, 0.42 * intensity)} 100%)`,
        }}
      />
      {/* Off-centre second wash so the vignette isn't perfectly symmetric */}
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          background: `radial-gradient(140% 110% at 30% 100%,
            transparent 0%,
            ${rgba(c, 0.15 * intensity)} 75%,
            ${rgba(c, 0.3 * intensity)} 100%)`,
          mixBlendMode: 'multiply',
          opacity: 0.55,
        }}
      />
      <span className="ice-crackle" />
    </span>
  );
};
