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
  shareStats: boolean;
  searchFallback: boolean;
  cacheSize?: number;
  cacheAge?: string;
  version: string;
  contract: string;
  /** Optional advanced fields — when present, render Worker URL/secret inputs. */
  workerUrl?: string;
  workerSecret?: string;
  /** True when the build did not bake a default Worker — forces Advanced open. */
  forceAdvanced?: boolean;
}

export interface SettingsTabProps {
  values: SettingsValues;
  onChange: (patch: Partial<SettingsValues>) => void;
  onTestConnection: () => void;
  onRefreshCache: () => void;
  /** Optional slot rendered below Privacy — used to host the wallet
   *  connect status / disconnect button. */
  walletSlot?: React.ReactNode;
  /** Optional test-connection result text/status. */
  testStatus?: string;
}

// Kept aligned with what the extension actually supports — see
// EmbeddingProvider in src/shared/types.ts.
const PROVIDERS = [
  'Local (free, runs on your device)',
  'OpenAI · text-embedding-3-small',
];

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
  walletSlot,
  testStatus,
}) => {
  // Local state for sliders so dragging is smooth; commit on release.
  const [conf, setConf] = useState(values.confidence);
  const [floor, setFloor] = useState(values.floor);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(values.forceAdvanced));

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
        {testStatus && (
          <div style={{ marginTop: 6 }}>
            <Etched size={11} weight={300} color="rgba(35,45,70,.55)">
              {testStatus}
            </Etched>
          </div>
        )}
      </Field>

      {(showAdvanced || values.forceAdvanced) ? (
        <Field label="Worker (advanced)">
          <input
            type="url"
            placeholder="https://actually-api.<you>.workers.dev"
            value={values.workerUrl ?? ''}
            onChange={(e) => onChange({ workerUrl: e.target.value })}
            className="thin-glass"
            style={{ marginBottom: 8 }}
          />
          <input
            type="password"
            placeholder="Worker shared secret"
            value={values.workerSecret ?? ''}
            onChange={(e) => onChange({ workerSecret: e.target.value })}
            className="thin-glass"
          />
        </Field>
      ) : (
        <div style={{ padding: '0 4px' }}>
          <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
            Using bundled API.{' '}
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              style={{
                appearance: 'none', background: 'none', border: 0, padding: 0,
                cursor: 'pointer', font: 'inherit', color: 'rgba(35,80,160,.85)',
                textDecoration: 'underline',
              }}
            >
              Self-host?
            </button>
          </Etched>
        </div>
      )}

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

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(255,255,255,.06)',
            border: '1px solid rgba(255,255,255,.22)',
          }}
        >
          <div style={{ flex: 1 }}>
            <Etched size={13} weight={400} style={{ display: 'block' }}>
              Search Polymarket when nothing matches
            </Etched>
            <Etched size={11} weight={300} color="rgba(35,45,70,.5)">
              Finds markets too small for the local list. Sends up to six words from the
              headline to Polymarket. Off means article text never leaves your device.
            </Etched>
          </div>
          <NeutralToggle
            on={values.searchFallback}
            onChange={(v) => onChange({ searchFallback: v })}
          />
        </div>
      </Field>

      {walletSlot && <Field label="Wallet">{walletSlot}</Field>}

      <Field label="Wallet connect log">
        <ConnectLogPanel />
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
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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

/**
 * The connect flow's own trace, shown in the UI.
 *
 * Everything that goes wrong in wallet connect has been invisible: Chrome
 * closes the popup (and its console) on focus loss, the offscreen document's
 * console is buried behind chrome://extensions → Inspect views, and no
 * external tool can attach to another extension's pages at all. So a failure
 * could only ever be described by its symptom — which is exactly how the same
 * bug got "fixed" more than once without being found. This makes the last
 * attempt readable and copyable in two clicks.
 */
const ConnectLogPanel: React.FC = () => {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const { getConnectLog, formatConnectLog } = await import('../../background/connectLog');
    setText(formatConnectLog(await getConnectLog()));
    setCopied(false);
  }

  return (
    <div
      style={{
        padding: '9px 12px',
        borderRadius: 8,
        background: 'rgba(255,255,255,.05)',
        border: '1px solid rgba(255,255,255,.2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <Etched size={11} weight={300} color="rgba(35,45,70,.6)" style={{ lineHeight: 1.45 }}>
        A step-by-step trace of your last connect attempt. No keys, signatures
        or full addresses are recorded.
      </Etched>

      {text === null ? (
        <GlassButton size="sm" onClick={load}>Show last attempt</GlassButton>
      ) : (
        <>
          <pre
            style={{
              margin: 0,
              maxHeight: 180,
              overflow: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 10.5,
              lineHeight: 1.5,
              color: 'rgba(35,45,70,.85)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {text}
          </pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <GlassButton
              size="sm"
              full
              onClick={() => {
                void navigator.clipboard.writeText(text);
                setCopied(true);
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </GlassButton>
            <GlassButton size="sm" full onClick={load}>Refresh</GlassButton>
          </div>
        </>
      )}
    </div>
  );
};
