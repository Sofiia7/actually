import React, { useRef } from 'react';
import { rgbAt, rgba, frostRgb } from '../colors';
import { IcePlate } from './IcePlate';

export interface IceCardProps {
  /** 0–100 market probability; null/undefined for neutral cards. */
  pct?: number | null;
  /** Multiplier on the rim color intensity. Tiny rows use ~0.6. */
  intensity?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
  borderRadius?: number;
  padding?: string;
  onClick?: () => void;
  /** Skip the IcePlate texture — useful for neutral utility cards. */
  plain?: boolean;
}

const LAYOUT_KEYS = new Set([
  'display',
  'alignItems',
  'justifyContent',
  'flexDirection',
  'flexWrap',
  'gap',
  'rowGap',
  'columnGap',
]);

/**
 * IceCard — a market panel with rim color, crystalline texture,
 * and a cursor-following crumpled-glass trail (via .frost-needles).
 *
 * The component splits the consumer's `style` into:
 *   - layout keys (display / flex / gap …) → applied to the inner
 *     content wrapper so children flow correctly
 *   - everything else → applied to the outer chrome
 */
export const IceCard: React.FC<IceCardProps> = ({
  pct,
  intensity = 1,
  children,
  style = {},
  borderRadius = 10,
  padding = '14px 16px',
  onClick,
  plain = false,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty(
      '--mx',
      ((e.clientX - r.left) / r.width) * 100 + '%',
    );
    el.style.setProperty(
      '--my',
      ((e.clientY - r.top) / r.height) * 100 + '%',
    );
  };

  const isNeutral = pct == null;
  const c = isNeutral ? ([255, 255, 255] as const) : rgbAt(pct!);

  const innerLayout: React.CSSProperties = {};
  const outerRest: React.CSSProperties = {};
  for (const [k, v] of Object.entries(style)) {
    if (LAYOUT_KEYS.has(k)) (innerLayout as any)[k] = v;
    else (outerRest as any)[k] = v;
  }

  return (
    <div
      ref={ref}
      className="frost-host"
      onMouseMove={onMove}
      onClick={onClick}
      style={{
        position: 'relative',
        padding,
        borderRadius,
        background: isNeutral
          ? 'rgba(255,255,255,.05)'
          : rgba(c as any, 0.04),
        border: `1px solid ${
          isNeutral
            ? 'rgba(255,255,255,.28)'
            : rgba(c as any, 0.45)
        }`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        boxShadow: 'none',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        ['--frost-rgb' as any]: isNeutral ? '235,245,255' : frostRgb(pct!),
        ...outerRest,
      }}
    >
      {!plain && !isNeutral && (
        <IcePlate pct={pct!} intensity={intensity} />
      )}
      <span aria-hidden className="frost-needles" />
      <div style={{ position: 'relative', zIndex: 1, ...innerLayout }}>
        {children}
      </div>
    </div>
  );
};
