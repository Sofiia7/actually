import React, { useState } from 'react';
import { GlassSurface } from './components/GlassSurface';
import { Header } from './components/Header';
import { Tabs, TabName } from './components/Tabs';
import {
  CheckTab,
  CheckState,
  CheckTabProps,
  Market,
} from './tabs/CheckTab';
import {
  TradeTab,
  TradeState,
  TradeTabProps,
  Suggestion,
} from './tabs/TradeTab';
import {
  HistoryTab,
  HistoryState,
  HistoryTabProps,
  HistoryRow,
} from './tabs/HistoryTab';
import {
  SettingsTab,
  SettingsTabProps,
  SettingsValues,
} from './tabs/SettingsTab';

// Re-export the state contracts so consumers can build them externally.
export type {
  CheckState,
  TradeState,
  HistoryState,
  Market,
  Suggestion,
  HistoryRow,
  SettingsValues,
};

export interface PopupProps {
  /** Tab state. If omitted, the popup uses internal demo state. */
  check?: CheckTabProps;
  trade?: TradeTabProps;
  history?: HistoryTabProps;
  settings?: SettingsTabProps;
  /** Initial active tab. */
  initialTab?: TabName;
  /** Optional outer style override (positioning, width, etc.). */
  style?: React.CSSProperties;
  /** Show the small pointer arrow at top-right that points at the
   *  extension toolbar icon. Default true. */
  pointer?: boolean;
}

const DEFAULT_FEATURED: Market = {
  q: 'US obtains Iranian enriched uranium by May 31?',
  pct: 4,
  vol: '$15.2M',
  match: 57,
  market: 'Polymarket',
};
const DEFAULT_RELATED: Market[] = [
  { q: 'Will Reza Pahlavi lead Iran in 2026?', pct: 64 },
  { q: 'Will the Iranian regime fall before 2027?', pct: 59 },
  { q: 'Will Reza Pahlavi enter Iran by June 30?', pct: 23 },
  { q: 'Will the Iranian regime fall by May 31?', pct: 7 },
];
const DEFAULT_HISTORY: HistoryRow[] = [
  { pct: 7,  q: 'Will Reza Pahlavi lead Iran in 2026?',  src: 'reuters.com',   when: '2m ago'    },
  { pct: 64, q: 'Fed cuts rates 25bps in July?',         src: 'bloomberg.com', when: '1h ago'    },
  { pct: 22, q: 'AI bubble pops before Q4 2026?',        src: 'ft.com',        when: 'yesterday' },
  { pct: 88, q: 'Bitcoin above $150k by year end?',      src: 'coindesk.com',  when: '2d ago'    },
  { pct: 41, q: 'Apple ships AR glasses in 2026?',       src: 'theverge.com',  when: '4d ago'    },
];
const DEFAULT_SETTINGS: SettingsValues = {
  provider: 'Local (free, runs on your device)',
  confidence: 0.45,
  floor: 0.3,
  language: 'English',
  shareStats: true,
  cacheSize: 300,
  cacheAge: '7m ago',
  version: '1.0.0',
  contract:
    '0x6d5e42fba90be632cca4697ffd5002272f4f442fa1a391a0f6b3aaa550cabf5a',
};

/**
 * Top-level popup. Composes Header + Tabs + the active tab.
 *
 * Pass `check` / `trade` / `history` / `settings` props from your
 * host to wire real data. Omit them for a self-contained demo.
 */
export const Popup: React.FC<PopupProps> = ({
  check,
  trade,
  history,
  settings,
  initialTab = 'Check',
  style,
  pointer = true,
}) => {
  const [tab, setTab] = useState<TabName>(initialTab);

  // -------- internal demo state (only used when prop missing) --------
  const [checkState, setCheckState] = useState<CheckState>({ kind: 'idle' });
  const internalCheck: CheckTabProps = {
    state: checkState,
    onStart: () => {
      setCheckState({ kind: 'loading' });
      setTimeout(
        () =>
          setCheckState({
            kind: 'success',
            featured: DEFAULT_FEATURED,
            related: DEFAULT_RELATED,
          }),
        1500,
      );
    },
    onBack: () => setCheckState({ kind: 'idle' }),
  };

  const internalTrade: TradeTabProps = {
    state: {
      kind: 'success',
      suggestion: {
        q: 'Will Reza Pahlavi lead Iran in 2026?',
        pct: 72,
        side: 'YES',
        market: 'polymarket',
      },
    },
    onBet: () => {},
    onSkip: () => {},
  };

  const internalHistory: HistoryTabProps = {
    state: { kind: 'success', items: DEFAULT_HISTORY },
    onSelect: () => {},
    onClear: () => {},
  };

  const [demoSettings, setDemoSettings] = useState(DEFAULT_SETTINGS);
  const internalSettings: SettingsTabProps = {
    values: demoSettings,
    onChange: (patch) => setDemoSettings({ ...demoSettings, ...patch }),
    onTestConnection: () => {},
    onRefreshCache: () => {},
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 14,
        right: 28,
        width: 360,
        ...style,
      }}
    >
      {pointer && (
        <div
          style={{
            position: 'absolute',
            top: -6,
            right: 42,
            width: 12,
            height: 12,
            background: 'rgba(255,255,255,.04)',
            backdropFilter: 'blur(38px) saturate(108%)',
            WebkitBackdropFilter: 'blur(38px) saturate(108%)',
            border: '1px solid rgba(255,255,255,.22)',
            borderRight: 'none',
            borderBottom: 'none',
            transform: 'rotate(45deg)',
            borderTopLeftRadius: 2,
          }}
        />
      )}
      <GlassSurface radius={12}>
        <Header />
        <Tabs value={tab} onChange={setTab} />
        <div style={{ minHeight: 360 }}>
          {tab === 'Check' && <CheckTab {...(check ?? internalCheck)} />}
          {tab === 'Trade' && <TradeTab {...(trade ?? internalTrade)} />}
          {tab === 'History' && (
            <HistoryTab {...(history ?? internalHistory)} />
          )}
          {tab === 'Settings' && (
            <SettingsTab {...(settings ?? internalSettings)} />
          )}
        </div>
      </GlassSurface>
    </div>
  );
};
