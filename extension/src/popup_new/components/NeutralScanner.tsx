import React from 'react';

/** Concentric neutral rings + a centered bead. Used for the
 *  Check tab loading state. Animation lives in styles.css. */
export const NeutralScanner: React.FC = () => (
  <div style={{ position: 'relative', width: 72, height: 72 }}>
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: '1px solid rgba(35,45,70,.35)',
          animation: `spin ${2.2 + i * 0.5}s linear infinite ${
            i % 2 ? 'reverse' : ''
          }`,
          transform: `scale(${0.5 + i * 0.22})`,
        }}
      />
    ))}
    <span
      style={{
        position: 'absolute',
        inset: 0,
        margin: 'auto',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 30% 25%, #fff, rgba(35,45,70,.6))',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
      }}
    />
  </div>
);
