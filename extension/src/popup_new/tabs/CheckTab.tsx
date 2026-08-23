import React from 'react';
import { IceCard } from '../components/IceCard';
import { Etched } from '../components/Etched';
import { ProbDot, PctChip } from '../components/ProbDot';
import { LinkAction } from '../components/LinkAction';
import { GlassButton } from '../components/GlassButton';
import { NeutralScanner } from '../components/NeutralScanner';
import { rgbAt, rgba, toneDark } from '../colors';
import type { TranslationNotice } from '../translate';

// =============================================================
// CheckTab - public state contract
// =============================================================
export interface Market {
  q: string;
  pct: number;
  vol?: string;
  match?: number;
  market?: string;
  /** Short market description - clarifies what the question actually resolves on. */
  desc?: string;
}

export type CheckState =
  | { kind: 'idle' }
  | {
      kind: 'loading';
      /** Replaces "reading article…" while something slower is happening -
       *  a one-time language-pack download, for instance. */
      note?: string;
    }
  | { kind: 'empty' }
  | {
      kind: 'error';
      message: string;
      /** Second line, quieter: the specifics behind `message`. */
      detail?: string;
      /** When set, an action that opens this URL - for a dead end the user
       *  can still follow up on somewhere else. */
      searchUrl?: string;
      /**
       * Offer to switch on the long-tail search right here.
       *
       * The setting is off by default and lives in Settings, which is exactly
       * where nobody looks. The one moment it is worth mentioning is the
       * moment it would have helped: a check that just came back empty.
       */
      offerSearch?: boolean;
    }
  | { kind: 'success'; featured: Market; related: Market[] };

export interface CheckTabProps {
  state: CheckState;
  onStart: () => void;
  onBack: () => void;
  onRetry?: () => void;
  /** Click "View on Polymarket →" on the featured match. */
  onOpenMarket?: () => void;
  /** Accept the no-match screen's offer: turn long-tail search on and retry. */
  onEnableSearch?: () => void;
  /** Decline it, for good. */
  onDismissSearchOffer?: () => void;
  /** Click "Trade this market →" on the featured match - switches to Trade tab. */
  onTrade?: () => void;
  /** Click an alternate match - re-runs in CheckTab as the new featured. */
  onPickRelated?: (index: number) => void;
  /**
   * What happened to the article's text before it was matched: translated
   * from another language, or why it could not be. Sits above the result
   * because it changes how the result should be read - "no market matched"
   * means something different when the page was never in English.
   */
  notice?: TranslationNotice | null;
}

const NoticeBanner: React.FC<{ notice: TranslationNotice }> = ({ notice }) => {
  const warn = notice.tone === 'warn';
  return (
    <div
      style={{
        margin: '10px 14px 0',
        padding: '9px 11px',
        borderRadius: 9,
        background: warn ? 'rgba(150,40,40,.07)' : 'rgba(255,255,255,.07)',
        border: `1px solid ${warn ? 'rgba(150,40,40,.22)' : 'rgba(255,255,255,.24)'}`,
      }}
    >
      <Etched
        size={11.5}
        weight={300}
        color={warn ? 'rgba(150,40,40,.85)' : 'rgba(35,45,70,.6)'}
        style={{ lineHeight: 1.45 }}
      >
        {notice.text}
      </Etched>
    </div>
  );
};

// =============================================================
// Featured + related market sub-components
// =============================================================
interface FeaturedMarketProps extends Market {
  onOpenMarket?: () => void;
  onTrade?: () => void;
}
const FeaturedMarket: React.FC<FeaturedMarketProps> = ({
  q,
  pct,
  vol,
  match,
  market,
  desc,
  onOpenMarket,
  onTrade,
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

      {desc && (
        <Etched
          size={11}
          weight={300}
          color="rgba(35,45,70,.6)"
          style={{ display: 'block', lineHeight: 1.4, marginTop: -6, marginBottom: 12 }}
        >
          {desc}
        </Etched>
      )}

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
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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
        {market && onOpenMarket && (
          <LinkAction onClick={onOpenMarket}>View on {market} →</LinkAction>
        )}
        {onTrade && (
          <LinkAction onClick={onTrade}>Trade this market →</LinkAction>
        )}
      </div>
    </IceCard>
  );
};

const RelatedRow: React.FC<Market & { onClick?: () => void }> = ({ q, pct, onClick }) => {
  const card = (
    <IceCard
      pct={pct}
      intensity={0.6}
      padding="9px 12px"
      borderRadius={8}
      style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: onClick ? 'pointer' : 'default' }}
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
  if (!onClick) return card;
  // Picking an alternate promotes it to the featured match (ТЗ §6.1 - "in case
  // the user disagrees with #1"); it then flows through to the Trade tab.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`Use this market: ${q}`}
    >
      {card}
    </div>
  );
};

// =============================================================
// CheckTab - state machine
// =============================================================
export const CheckTab: React.FC<CheckTabProps> = (props) => {
  // Nothing has been checked yet on the idle screen, so there is nothing to
  // explain - the banner would be reporting on a page the user never asked
  // about.
  if (props.state.kind === 'idle' || !props.notice) return <CheckTabBody {...props} />;
  return (
    <>
      <NoticeBanner notice={props.notice} />
      <CheckTabBody {...props} />
    </>
  );
};

const CheckTabBody: React.FC<CheckTabProps> = ({
  state,
  onStart,
  onBack,
  onRetry,
  onOpenMarket,
  onEnableSearch,
  onDismissSearchOffer,
  onTrade,
  onPickRelated,
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
        <Etched
          size={13}
          weight={300}
          color="rgba(35,45,70,.55)"
          style={{ textAlign: 'center', lineHeight: 1.4 }}
        >
          {state.note ?? 'reading article…'}
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
        {state.detail && (
          <Etched
            size={11.5}
            weight={300}
            color="rgba(35,45,70,.55)"
            style={{ textAlign: 'center', lineHeight: 1.45 }}
          >
            {state.detail}
          </Etched>
        )}
        {state.offerSearch && onEnableSearch ? (
          // Shown INSTEAD of the plain outbound link: at this exact moment the
          // useful thing is not a detour to polymarket.com, it is the feature
          // that would have caught this market. Both at once is clutter.
          <div
            style={{
              padding: '11px 13px',
              borderRadius: 10,
              background: 'rgba(255,255,255,.07)',
              border: '1px solid rgba(255,255,255,.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'center',
              textAlign: 'center',
            }}
          >
            <Etched size={11.5} weight={300} color="rgba(35,45,70,.7)" style={{ lineHeight: 1.45 }}>
              Only the biggest markets are matched on your device. Polymarket carries
              thousands more, including small and brand-new ones.
            </Etched>
            <GlassButton size="md" onClick={onEnableSearch}>
              Search Polymarket too
            </GlassButton>
            <Etched size={10.5} weight={300} color="rgba(35,45,70,.5)" style={{ lineHeight: 1.4 }}>
              Sends up to six words from the headline when nothing matches locally.
              Switch it off any time in Settings.
            </Etched>
            {onDismissSearchOffer && (
              <LinkAction size={11} onClick={onDismissSearchOffer}>
                No thanks
              </LinkAction>
            )}
          </div>
        ) : (
          state.searchUrl && (
            <LinkAction
              onClick={() => window.open(state.searchUrl!, '_blank', 'noopener,noreferrer')}
            >
              Search Polymarket →
            </LinkAction>
          )
        )}
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
      <FeaturedMarket
        {...state.featured}
        onOpenMarket={onOpenMarket}
        onTrade={onTrade}
      />
      <div style={{ padding: '2px 6px' }}>
        <span className="label">Other related markets</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {state.related.map((m, i) => (
          <RelatedRow key={i} {...m} onClick={onPickRelated ? () => onPickRelated(i) : undefined} />
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
