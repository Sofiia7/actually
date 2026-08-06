import React from 'react';
import { IceCard } from '../components/IceCard';
import { Etched } from '../components/Etched';
import { ProbDot, PctChip } from '../components/ProbDot';
import { GlassButton } from '../components/GlassButton';
import { NeutralScanner } from '../components/NeutralScanner';

// =============================================================
// HistoryTab — public state contract
// =============================================================
export interface HistoryRow {
  pct: number;
  q: string;
  src: string;
  when: string;
}

export type HistoryState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'success'; items: HistoryRow[] };

export interface HistoryTabProps {
  state: HistoryState;
  /** `index` is this row's position in `state.items` — use it to address the
   * backing item directly rather than re-matching by displayed text. */
  onSelect: (row: HistoryRow, index: number) => void;
  onOpenArticle: (row: HistoryRow, index: number) => void;
  onClear: () => void;
}

// =============================================================
const Row: React.FC<HistoryRow & { onClick?: () => void; onOpenArticle?: () => void }> = ({
  pct,
  q,
  src,
  when,
  onClick,
  onOpenArticle,
}) => (
  <IceCard
    pct={pct}
    intensity={0.6}
    padding="9px 12px"
    borderRadius={8}
    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
    onClick={onClick}
  >
    <span style={{ display: 'inline-flex' }}>
      <ProbDot pct={pct} size={7} />
    </span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <Etched
        size={13}
        weight={400}
        style={{
          lineHeight: 1.3,
          display: 'block',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {q}
      </Etched>
      <span
        style={{
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          fontSize: 10.5,
          color: 'rgba(35,45,70,.6)',
          letterSpacing: '.04em',
        }}
      >
        {src} · {when}
      </span>
    </div>
    <button
      type="button"
      title="Open original article"
      onClick={(e) => {
        e.stopPropagation();
        onOpenArticle?.();
      }}
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        padding: 4,
        margin: 0,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
        color: 'rgba(35,45,70,.45)',
        flexShrink: 0,
      }}
    >
      ↗
    </button>
    <PctChip pct={pct} />
  </IceCard>
);

// =============================================================
export const HistoryTab: React.FC<HistoryTabProps> = ({
  state,
  onSelect,
  onOpenArticle,
  onClear,
}) => {
  if (state.kind === 'loading') {
    return (
      <div
        style={{
          padding: '40px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <NeutralScanner />
        <Etched size={13} weight={300} color="rgba(35,45,70,.55)">
          loading…
        </Etched>
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div
        style={{
          padding: '34px 18px 30px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <Etched
          size={14}
          weight={300}
          italic
          family="serif"
          color="rgba(35,45,70,.65)"
          style={{ textAlign: 'center', lineHeight: 1.4 }}
        >
          Nothing here yet.
        </Etched>
        <Etched
          size={12}
          weight={300}
          color="rgba(35,45,70,.45)"
          style={{ textAlign: 'center' }}
        >
          Checked stories will appear here.
        </Etched>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 14px 20px' }}>
      <div style={{ padding: '0 4px 8px' }}>
        <span className="label">Recent matches</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {state.items.map((m, i) => (
          <Row key={i} {...m} onClick={() => onSelect(m, i)} onOpenArticle={() => onOpenArticle(m, i)} />
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <GlassButton size="md" full danger onClick={onClear}>
          Clear history
        </GlassButton>
      </div>
    </div>
  );
};
