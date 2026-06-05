import React, { useEffect, useRef, useState } from 'react';

export type TabName = 'Check' | 'Trade' | 'History' | 'Settings';

export interface TabsProps {
  value: TabName;
  onChange: (v: TabName) => void;
}

const items: TabName[] = ['Check', 'Trade', 'History', 'Settings'];

export const Tabs: React.FC<TabsProps> = ({ value, onChange }) => {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [bar, setBar] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const el = refs.current[value];
    if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        gap: 0,
        padding: '0 16px',
        borderBottom: '1px solid rgba(255,255,255,.4)',
      }}
    >
      {items.map((it) => {
        const active = it === value;
        return (
          <button
            key={it}
            type="button"
            ref={(el) => {
              refs.current[it] = el;
            }}
            onClick={() => onChange(it)}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 0,
              padding: '13px 13px',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: active ? 500 : 300,
              color: active ? 'rgba(18,26,48,.9)' : 'rgba(35,45,70,.52)',
              letterSpacing: '-0.005em',
              textShadow: '0 1px 0 rgba(255,255,255,.55)',
              cursor: 'pointer',
              transition: 'color .15s ease',
            }}
          >
            {it}
          </button>
        );
      })}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: bar.left + 10,
          width: bar.width - 20,
          height: 1.5,
          bottom: -1,
          background: 'rgba(18,26,48,.55)',
          borderRadius: 1,
          transition:
            'left .25s cubic-bezier(.5,.1,.2,1), width .25s cubic-bezier(.5,.1,.2,1)',
        }}
      />
    </div>
  );
};
