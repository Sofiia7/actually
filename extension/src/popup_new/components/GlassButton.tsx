import React from 'react';

export interface GlassButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  full?: boolean;
  size?: 'sm' | 'md' | 'lg';
  danger?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  /**
   * Set on buttons used as a segmented toggle (order type, BUY YES / BUY NO).
   * Renders `aria-pressed`, so the selected state is exposed to assistive
   * tech and to tests instead of living only in a colour difference.
   */
  selected?: boolean;
}

/**
 * Glass button. Flat at rest, becomes convex on hover (gradient
 * highlight + lifted shadow + 0.5px lift) - see `.glass-btn` in
 * styles.css. No cursor-tracked shimmer, intentionally calm.
 */
export const GlassButton: React.FC<GlassButtonProps> = ({
  children,
  onClick,
  full = false,
  size = 'md',
  danger = false,
  disabled = false,
  style,
  selected,
}) => {
  const pad =
    size === 'lg' ? '12px 18px' : size === 'sm' ? '8px 12px' : '10px 14px';
  const fz = size === 'lg' ? 14 : size === 'sm' ? 12 : 13;
  const txt = danger ? 'rgba(150,40,40,.88)' : 'rgba(18,26,48,.85)';

  return (
    <button
      type="button"
      className="glass-btn"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        width: full ? '100%' : 'auto',
        padding: pad,
        fontSize: fz,
        color: txt,
        borderRadius: 8,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      <span>{children}</span>
    </button>
  );
};
