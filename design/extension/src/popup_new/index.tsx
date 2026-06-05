import React from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './styles.css';
import { Popup } from './Popup';

/**
 * Demo entry — mounts the popup over a fake browser chrome so you
 * can preview the design in isolation. In the real extension, just
 * render <Popup /> inside your popup HTML's root.
 */

const BrowserChrome: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#d5d9e0',
    }}
  >
    <div
      style={{
        background: '#c8cdd7',
        padding: '8px 12px 0',
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      <div
        style={{
          background: '#eef0f4',
          borderRadius: '10px 10px 0 0',
          padding: '8px 16px',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: 240,
          color: 'rgba(20,30,55,.7)',
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            background: '#b8bfca',
          }}
        />
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Reuters · Iran politics
        </span>
      </div>
      <div
        style={{
          background: 'rgba(255,255,255,.3)',
          borderRadius: '10px 10px 0 0',
          padding: '8px 12px',
          fontSize: 12,
          color: 'rgba(35,45,70,.5)',
        }}
      >
        +
      </div>
    </div>
    <div
      style={{
        background: '#eef0f4',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderBottom: '1px solid rgba(20,30,55,.07)',
      }}
    >
      <span style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <i
            key={i}
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: 'rgba(20,30,55,.05)',
            }}
          />
        ))}
      </span>
      <div
        style={{
          flex: 1,
          height: 28,
          borderRadius: 6,
          background: '#e2e5ec',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          fontSize: 12,
          color: 'rgba(35,45,70,.7)',
          fontFamily: 'JetBrains Mono',
        }}
      >
        reuters.com/world/middle-east/iran-pahlavi-2026
      </div>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <i
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: 'rgba(20,30,55,.05)',
          }}
        />
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background:
              'linear-gradient(180deg, rgba(255,255,255,.5), rgba(255,255,255,.2))',
            border: '1px solid rgba(255,255,255,.7)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,.7), 0 0 0 2px rgba(18,26,48,.08)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(18,26,48,.85)',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'Instrument Serif',
            fontStyle: 'italic',
          }}
        >
          A
        </span>
      </span>
    </div>
    <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
      {children}
    </div>
  </div>
);

const FakeArticle: React.FC = () => (
  <div
    style={{
      maxWidth: 760,
      margin: '0 auto',
      padding: '32px 32px 80px',
      fontFamily: '"Times New Roman", Times, serif',
      color: '#1a1a1a',
    }}
  >
    <div
      style={{
        fontSize: 11,
        fontFamily: 'JetBrains Mono',
        textTransform: 'uppercase',
        letterSpacing: '.16em',
        color: '#a02929',
      }}
    >
      World · Middle East
    </div>
    <h1
      style={{
        fontSize: 38,
        lineHeight: 1.15,
        margin: '10px 0 12px',
        fontWeight: 700,
        letterSpacing: '-0.01em',
      }}
    >
      Iranian opposition rallies behind Pahlavi as 2026 elections approach
    </h1>
    <div style={{ fontSize: 13, color: '#6b7280', fontFamily: 'Inter' }}>
      By A. Karimi · May 20, 2026 · 6 min read
    </div>
    <div
      style={{
        marginTop: 22,
        marginBottom: 22,
        height: 260,
        borderRadius: 4,
        background: 'linear-gradient(135deg,#9aa3b8,#3e455a)',
        display: 'flex',
        alignItems: 'flex-end',
        padding: 14,
        color: '#fff',
        fontFamily: 'JetBrains Mono',
        fontSize: 11,
      }}
    >
      [ photo: rally crowd in Tehran ]
    </div>
    {[
      `Speculation in prediction markets has reached new highs this week.`,
      `Polymarket, Kalshi and Manifold have all reported volume spikes.`,
    ].map((p, i) => (
      <p key={i} style={{ fontSize: 17, lineHeight: 1.6, margin: '0 0 16px' }}>
        {p}
      </p>
    ))}
  </div>
);

const App: React.FC = () => (
  <BrowserChrome>
    <FakeArticle />
    <Popup />
  </BrowserChrome>
);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
