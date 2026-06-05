import React from 'react';
import { IceCard } from '../components/IceCard';
import { Etched } from '../components/Etched';
import { GlassButton } from '../components/GlassButton';
import { NeutralScanner } from '../components/NeutralScanner';
import { toneDark } from '../colors';

// =============================================================
// TradeTab — public state contract
// =============================================================
export interface Suggestion {
  q: string;
  pct: number;
  side: 'YES' | 'NO';
  market: string;
}

export type TradeState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; suggestion: Suggestion };

export interface TradeTabProps {
  state: TradeState;
  onBet: (s: Suggestion) => void;
  onSkip: () => void;
  onOpenSettings?: () => void;
}

// =============================================================
const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div
    style={{
      padding: '11px 13px',
      borderRadius: 8,
      background: 'rgba(200,140,40,.08)',
      border: '1px solid rgba(200,140,40,.38)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
    }}
  >
    <Etched
      size={12.5}
      weight={300}
      color="rgba(110,75,15,.85)"
      style={{ lineHeight: 1.45 }}
    >
      {message}
    </Etched>
  </div>
);

// =============================================================
export const TradeTab: React.FC<TradeTabProps> = ({
  state,
  onBet,
  onSkip,
  onOpenSettings,
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
          finding a trade…
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
          gap: 12,
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
          No suggested trade right now.
        </Etched>
        <Etched size={12} weight={300} color="rgba(35,45,70,.45)">
          Check a story first to surface markets.
        </Etched>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        style={{
          padding: '14px 18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <ErrorBanner message={state.message} />
        {onOpenSettings && (
          <GlassButton size="md" full onClick={onOpenSettings}>
            Open settings
          </GlassButton>
        )}
      </div>
    );
  }

  // success
  const { suggestion } = state;
  const { pct } = suggestion;

  return (
    <div
      style={{
        padding: '14px 18px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ paddingLeft: 6 }}>
        <span className="label">Suggested trade</span>
      </div>

      <IceCard pct={pct} intensity={1} padding="13px 14px" borderRadius={10}>
        <Etched
          size={13.5}
          weight={400}
          style={{ display: 'block', lineHeight: 1.3, marginBottom: 6 }}
        >
          {suggestion.q}
        </Etched>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <span
            style={{
              fontFamily: 'Instrument Serif',
              fontSize: 38,
              fontWeight: 400,
              color: toneDark(pct, 0.97),
              letterSpacing: '-0.025em',
              textShadow: '0 1px 0 rgba(255,255,255,.55)',
              lineHeight: 1,
            }}
          >
            {pct}%
          </span>
          <Etched size={12} weight={300} color="rgba(35,45,70,.55)">
            {suggestion.side} · {suggestion.market}
          </Etched>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <GlassButton size="md" full onClick={() => onBet(suggestion)}>
            Bet against · {suggestion.side === 'YES' ? 'NO' : 'YES'}
          </GlassButton>
          <GlassButton size="md" onClick={onSkip}>
            Skip
          </GlassButton>
        </div>
      </IceCard>

      <Etched
        size={11}
        weight={300}
        color="rgba(35,45,70,.42)"
        style={{ textAlign: 'center', letterSpacing: '.04em' }}
      >
        Connect Worker in Settings to enable real trading.
      </Etched>
    </div>
  );
};
