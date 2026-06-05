import React from 'react';
import { IceCard } from '../components/IceCard';
import { Etched } from '../components/Etched';
import { ProbDot, PctChip } from '../components/ProbDot';
import { LinkAction } from '../components/LinkAction';
import { GlassButton } from '../components/GlassButton';
import { NeutralScanner } from '../components/NeutralScanner';
import { rgbAt, rgba, toneDark } from '../colors';

// =============================================================
// CheckTab — public state contract
// =============================================================
export interface Market {
  q: string;
  pct: number;
  vol?: string;
  match?: number;
  market?: string;
}

export type CheckState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; featured: Market; related: Market[] };

export interface CheckTabProps {
  state: CheckState;
  onStart: () => void;
  onBack: () => void;
  onRetry?: () => void;
}

// =============================================================
// Featured + related market sub-components
// =============================================================
const FeaturedMarket: React.FC<Market> = ({
  q,
  pct,
  vol,
  match,
  market,
}) => {
  const c = rgbAt(pct);
  return (
    <IceCard pct={pct} intensity={1} padding="14px 16px" borderRadius={10}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ProbDot pct={pct} size={7} />
          <span className="label">Market odds</span>
        </span>
        {match != null && <span className="label">Match {match}%</span>}
      </div>

      <Etched
        size={13.5}
        weight={400}
        style={{ display: 'block', lineHeight: 1.35, marginBottom: 12 }}
      >
        {q}
      </Etched>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: 'Instrument Serif',
            fontSize: 54,
            fontWeight: 400,
            color: toneDark(pct, 0.98),
            letterSpacing: '-0.025em',
            textShadow: '0 1px 0 rgba(255,255,255,.55)',
            lineHeight: 1,
          }}
        >
          {pct}%
        </span>
        <Etched size={12} weight={300} color="rgba(35,45,70,.55)">
          chance{vol ? ` · ${vol} volume` : ''}
        </Etched>
      </div>

      <div
        style={{
          position: 'relative',
          height: 3,
          borderRadius: 3,
          background: 'rgba(20,30,55,.07)',
          marginBottom: 12,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            borderRadius: 3,
            background: rgba(c, 0.85),
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: `calc(${pct}% - 4px)`,
            top: -3,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 30% 25%, #fff, rgba(255,255,255,.7))',
            boxShadow: '0 1px 2px rgba(20,30,55,.25)',
            border: `.5px solid ${rgba(c, 0.7)}`,
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {market && <LinkAction>View on {market} →</LinkAction>}
        <LinkAction>Trade this market →</LinkAction>
      </div>
    </IceCard>
  );
};

const RelatedRow: React.FC<Market> = ({ q, pct }) => (
  <IceCard
    pct={pct}
    intensity={0.6}
    padding="9px 12px"
    borderRadius={8}
    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
  >
    <span style={{ display: 'inline-flex' }}>
      <ProbDot pct={pct} size={6} />
    </span>
    <Etched size={13} weight={300} style={{ flex: 1, lineHeight: 1.3 }}>
      {q}
    </Etched>
    <PctChip pct={pct} />
  </IceCard>
);

// =============================================================
// CheckTab — state machine
// =============================================================
export const CheckTab: React.FC<CheckTabProps> = ({
  state,
  onStart,
  onBack,
  onRetry,
}) => {
  if (state.kind === 'idle') {
    return (
      <div
        style={{
          padding: '18px 18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <Etched size={14} weight={300} style={{ lineHeight: 1.5 }}>
          Reading a news story?
          <br />
          See what markets{' '}
          <Etched italic family="serif" size={17}>
            really
          </Etched>{' '}
          think about it.
        </Etched>
        <GlassButton size="lg" full onClick={onStart}>
          Check this page
        </GlassButton>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div
        style={{
          padding: '34px 18px 30px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          alignItems: 'center',
        }}
      >
        <NeutralScanner />
        <Etched size={13} weight={300} color="rgba(35,45,70,.55)">
          reading article…
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
          gap: 14,
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
          No markets matched this story.
        </Etched>
        <Etched size={12} weight={300} color="rgba(35,45,70,.45)">
          Try another page, or check back later.
        </Etched>
        <div style={{ height: 6 }} />
        <GlassButton size="md" onClick={onBack}>
          Back
        </GlassButton>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        style={{
          padding: '24px 18px 26px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <Etched
          size={13.5}
          weight={300}
          color="rgba(150,40,40,.85)"
          style={{ textAlign: 'center', lineHeight: 1.4 }}
        >
          {state.message}
        </Etched>
        <div style={{ display: 'flex', gap: 8 }}>
          {onRetry && (
            <GlassButton size="md" onClick={onRetry}>
              Try again
            </GlassButton>
          )}
          <GlassButton size="md" onClick={onBack}>
            Back
          </GlassButton>
        </div>
      </div>
    );
  }

  // success
  return (
    <div
      style={{
        padding: '12px 14px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <FeaturedMarket {...state.featured} />
      <div style={{ padding: '2px 6px' }}>
        <span className="label">Other related markets</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {state.related.map((m, i) => (
          <RelatedRow key={i} {...m} />
        ))}
      </div>
      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 0,
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 300,
            color: 'rgba(35,45,70,.6)',
            cursor: 'pointer',
            letterSpacing: '-0.005em',
            textShadow: '0 1px 0 rgba(255,255,255,.5)',
          }}
        >
          ← back
        </button>
      </div>
    </div>
  );
};
