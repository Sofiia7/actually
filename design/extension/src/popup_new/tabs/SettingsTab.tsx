import React, { useState } from 'react';
import { Etched } from '../components/Etched';
import { GlassButton } from '../components/GlassButton';
import { ThinSlider } from '../components/ThinSlider';
import { NeutralToggle } from '../components/NeutralToggle';
import { LinkAction } from '../components/LinkAction';

// =============================================================
// SettingsTab — props
// =============================================================
export interface SettingsValues {
  provider: string;
  confidence: number;
  floor: number;
  language: string;
  shareStats: boolean;
  cacheSize?: number;
  cacheAge?: string;
  version: string;
  contract: string;
}

export interface SettingsTabProps {
  values: SettingsValues;
  onChange: (patch: Partial<SettingsValues>) => void;
  onTestConnection: () => void;
  onRefreshCache: () => void;
}

const PROVIDERS = [
  'Local (free, runs on your device)',
  'OpenAI · text-embedding-3-small',
  'Cloudflare Workers AI',
];

const LANGUAGES = ['English', 'Русский', 'Español', 'Deutsch', '日本語'];

// =============================================================
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <div style={{ padding: '0 4px 8px' }}>
      <span className="label">{label}</span>
    </div>
    {children}
  </div>
);

// =============================================================
export const SettingsTab: React.FC<SettingsTabProps> = ({
  values,
  onChange,
  onTestConnection,
  onRefreshCache,
}) => {
  // Local state for sliders so dragging is smooth; commit on release.
  const [conf, setConf] = useState(values.confidence);
  const [floor, setFloor] = useState(values.floor);

  return (
    <div
      style={{
        padding: '12px 18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxHeight: 540,
        overflow: 'auto',
      }}
    >
      <Field label="Embedding provider">
        <select
          className="thin-glass"
          value={values.provider}
          onChange={(e) => onChange({ provider: e.target.value })}
        >
          {PROVIDERS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <div style={{ height: 8 }} />
        <GlassButton size="sm" full onClick={onTestConnection}>
          Test connection
        </GlassButton>
      </Field>

      <Field label="Behavior">
        <ThinSlider
          label="Confidence threshold"
          value={conf}
          setValue={(v) => {
            setConf(v);
            onChange({ confidence: v });
          }}
        />
        <div style={{ height: 10 }} />
        <ThinSlider
          label="Low-confidence floor"
          value={floor}
          setValue={(v) => {
            setFloor(v);
            onChange({ floor: v });
          }}
        />
      </Field>

      <div
        style={{
          padding: '9px 12px',
          borderRadius: 8,
          background: 'rgba(255,255,255,.06)',
          border: '1px solid rgba(255,255,255,.22)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Etched size={12} weight={300} color="rgba(35,45,70,.65)">
          Cache: {values.cacheSize ?? 0} markets · {values.cacheAge ?? 'just now'}
        </Etched>
        <LinkAction onClick={onRefreshCache}>Refresh now</LinkAction>
      </div>

      <Field label="Language">
        <select
          className="thin-glass"
          value={values.language}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>

      <Field label="Privacy">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,.06)',
            border: '1px solid rgba(255,255,255,.22)',
          }}
        >
          <div style={{ flex: 1 }}>
            <Etched size={13} weight={400} style={{ display: 'block' }}>
              Share anonymous usage stats
            </Etched>
            <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
              No personal data — helps us measure usefulness.
            </Etched>
          </div>
          <NeutralToggle
            on={values.shareStats}
            onChange={(v) => onChange({ shareStats: v })}
          />
        </div>
      </Field>

      <Field label="About">
        <div
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,.05)',
            border: '1px solid rgba(255,255,255,.2)',
          }}
        >
          <Etched size={12} weight={300}>
            Version {values.version}
          </Etched>
          <div
            style={{
              marginTop: 4,
              fontFamily: 'JetBrains Mono',
              fontSize: 10.5,
              color: 'rgba(35,45,70,.5)',
              wordBreak: 'break-all',
              letterSpacing: '.02em',
            }}
          >
            {values.contract}
          </div>
        </div>
      </Field>
    </div>
  );
};
