import React from 'react';
import { Etched } from './Etched';

export const ThinSlider: React.FC<{
  label: string;
  value: number;
  setValue: (v: number) => void;
}> = ({ label, value, setValue }) => {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <Etched size={12} weight={300} color="rgba(35,45,70,.6)">
          {label}
        </Etched>
        <Etched family="serif" size={13} color="rgba(18,26,48,.85)">
          {value.toFixed(2)}
        </Etched>
      </div>
      <div
        style={{
          position: 'relative',
          height: 18,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 2,
            borderRadius: 2,
            background: 'rgba(20,30,55,.10)',
            boxShadow: 'inset 0 1px 1px rgba(20,30,55,.06)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: 0,
            width: `${pct}%`,
            height: 2,
            borderRadius: 2,
            background: 'rgba(18,26,48,.45)',
          }}
        />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          className="thin"
          onChange={(e) => setValue(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
};
