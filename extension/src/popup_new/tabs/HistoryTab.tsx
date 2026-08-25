import React from 'react';
import { IceCard } from '../components/IceCard';
import { Etched } from '../components/Etched';
import { ProbDot, PctChip } from '../components/ProbDot';
import { GlassButton } from '../components/GlassButton';
import { NeutralScanner } from '../components/NeutralScanner';

// =============================================================
// HistoryTab - public state contract
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

/** One row of the activity log - see TradeLogItem for where it comes from. */
export interface TradeRow {
  kind: 'BUY' | 'SELL' | 'REDEEM';
  status: 'placed' | 'failed' | 'unknown';
  /**
   * How the order was sent. A LIMIT order that reached the exchange has not
   * necessarily traded - it can rest on the book unfilled - so it must not be
   * reported as a completed purchase.
   */
  orderType?: 'LIMIT' | 'MARKET';
  q: string;
  /** Pre-formatted detail line, e.g. "$2.00 · Yes @ 6.0¢ · limit". */
  detail: string;
  when: string;
  error?: string;
  onOpen?: () => void;
}

export interface HistoryTabProps {
  state: HistoryState;
  /** `index` is this row's position in `state.items` - use it to address the
   * backing item directly rather than re-matching by displayed text. */
  onSelect: (row: HistoryRow, index: number) => void;
  onOpenArticle: (row: HistoryRow, index: number) => void;
  onClear: () => void;
  /**
   * Your own trades, newest first. Rendered above the match list - a trade you
   * made outranks a story you glanced at.
   *
   * The two lists on this tab are different KINDS of record and used to be
   * labelled as though the difference were obvious: "Your trades" above
   * "Recent matches", with a red "Clear history" underneath that in fact
   * cleared only the matches. Nothing said which list that button belonged to,
   * or what a "match" was. Both headers now name their contents and carry a
   * count, and each clear control names its own scope.
   */
  trades?: TradeRow[];
  onClearTrades?: () => void;
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

const KIND_LABEL: Record<TradeRow['kind'], string> = {
  BUY: 'Bought',
  SELL: 'Sold',
  REDEEM: 'Redeemed',
};

/** Placed on the book is not the same as done. */
const RESTING_LABEL: Partial<Record<TradeRow['kind'], string>> = {
  BUY: 'Buy placed',
  SELL: 'Sell placed',
};

/** True while an order could still be sitting unfilled on the book. */
function isResting(t: TradeRow): boolean {
  return t.status === 'placed' && t.orderType === 'LIMIT' && t.kind !== 'REDEEM';
}

function tradeLabel(t: TradeRow): string {
  return (isResting(t) && RESTING_LABEL[t.kind]) || KIND_LABEL[t.kind];
}

const TradeRowView: React.FC<TradeRow> = (row) => {
  const { status, q, detail, when, error, onOpen } = row;
  const failed = status === 'failed';
  const unknown = status === 'unknown';
  const accent = failed
    ? 'rgba(160,40,40,.9)'
    : unknown
      ? 'rgba(150,105,20,.95)'
      : 'rgba(30,110,60,.9)';
  return (
    <div
      style={{
        padding: '8px 11px',
        borderRadius: 8,
        background: 'rgba(255,255,255,.05)',
        border: '1px solid rgba(255,255,255,.22)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <Etched size={11} weight={500} color={accent}>
          {tradeLabel(row)}
          {failed ? ' · failed' : unknown ? ' · unconfirmed' : ''}
        </Etched>
        <span
          style={{
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            fontSize: 10.5,
            color: 'rgba(35,45,70,.55)',
          }}
        >
          {when}
        </span>
      </div>
      <Etched
        size={12}
        weight={400}
        style={{ lineHeight: 1.3, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {q}
      </Etched>
      <Etched size={11} weight={300} color="rgba(35,45,70,.6)">
        {detail}
      </Etched>
      {error && (
        <Etched size={10.5} weight={300} color="rgba(160,40,40,.85)" style={{ lineHeight: 1.35 }}>
          {error}
        </Etched>
      )}
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          style={{
            appearance: 'none',
            background: 'none',
            border: 'none',
            padding: 0,
            marginTop: 2,
            alignSelf: 'flex-start',
            cursor: 'pointer',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            fontSize: 11,
            color: 'rgba(35,60,120,.85)',
          }}
        >
          Open on Polymarket →
        </button>
      )}
    </div>
  );
};

// =============================================================
export const HistoryTab: React.FC<HistoryTabProps> = ({
  state,
  onSelect,
  onOpenArticle,
  onClear,
  trades = [],
  onClearTrades,
}) => {
  const tradeSection = trades.length > 0 && (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px 8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="label">Your trades ({trades.length})</span>
          <Etched size={10.5} weight={300} color="rgba(35,45,70,.45)">
            Buys, sells and redeems you made here
          </Etched>
        </div>
        {onClearTrades && (
          <button
            type="button"
            onClick={onClearTrades}
            style={{
              appearance: 'none',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
              fontSize: 10.5,
              color: 'rgba(35,45,70,.5)',
            }}
          >
            Clear trades
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {trades.map((t, i) => (
          <TradeRowView key={i} {...t} />
        ))}
      </div>
      {trades.some(isResting) && (
        <Etched
          size={10.5}
          weight={300}
          color="rgba(35,45,70,.5)"
          style={{ display: 'block', lineHeight: 1.4, padding: '7px 4px 0' }}
        >
          A limit order rests on the book until it fills. Trade shows whether it did, and cancels it
          if it has not.
        </Etched>
      )}
    </div>
  );

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
    // Trades outlive matches (the log holds 100, matches 10) - an empty match
    // list must not hide a trade the user is looking for.
    return (
      <div style={{ padding: '12px 14px 20px' }}>
        {tradeSection}
        <div
          style={{
            padding: '22px 4px 10px',
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
            {trades.length > 0 ? 'No checked stories yet.' : 'Nothing here yet.'}
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
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 14px 20px' }}>
      {tradeSection}
      <div style={{ padding: '0 4px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="label">Stories you checked ({state.items.length})</span>
        <Etched size={10.5} weight={300} color="rgba(35,45,70,.45)">
          Pages you ran Check on, and the market each one matched
        </Etched>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {state.items.map((m, i) => (
          <Row key={i} {...m} onClick={() => onSelect(m, i)} onOpenArticle={() => onOpenArticle(m, i)} />
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <GlassButton size="md" full danger onClick={onClear}>
          Clear checked stories
        </GlassButton>
      </div>
    </div>
  );
};
