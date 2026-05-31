import React from 'react';

export const NeutralToggle: React.FC<{
  on: boolean;
  onChange: (v: boolean) => void;
}> = ({ on, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    aria-pressed={on}
    style={{
      position: 'relative',
      width: 38,
      height: 20,
      borderRadius: 999,
      border: '1px solid rgba(255,255,255,.28)',
      background: on ? 'rgba(18,26,48,.45)' : 'rgba(255,255,255,.08)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      boxShadow: 'none',
      cursor: 'pointer',
      transition: 'background .2s',
    }}
  >
    <span
      style={{
        position: 'absolute',
        top: 2,
        left: on ? 20 : 2,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background:
          'radial-gradient(circle at 30% 25%, #fff, rgba(255,255,255,.78))',
        border: '.5px solid rgba(255,255,255,.95)',
        boxShadow: '0 1px 3px rgba(20,30,55,.25)',
        transition: 'left .22s cubic-bezier(.5,.1,.2,1)',
      }}
    />
  </button>
);
