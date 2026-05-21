import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'
import type { MatchColor, MatchResult, Settings as SettingsT } from '../shared/types'
import { buildMarketUrl } from '../background/polymarket'
import { trackEvent } from '../background/telemetry'
import { runMatch } from './operations'

type State = 'idle' | 'loading' | 'found' | 'lowconf' | 'notfound' | 'nokeys' | 'error'

function emitMood(mood: MatchColor | null) {
  window.dispatchEvent(new CustomEvent('actually:mood', { detail: mood }))
}

function publishMatch(match: MatchResult | null) {
  window.dispatchEvent(new CustomEvent('actually:match', { detail: match }))
}

function switchTab(to: 'check' | 'trade' | 'history' | 'settings') {
  window.dispatchEvent(new CustomEvent('actually:tab', { detail: to }))
}

export function CheckPage() {
  const { t } = useTranslation()
  const [state, setState] = useState<State>('idle')
  const [match, setMatch] = useState<MatchResult | null>(null)
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [reason, setReason] = useState<string>('')

  useEffect(() => {
    void (async () => {
      const res = (await sendToBackground({ type: 'GET_SETTINGS' })) as Extract<
        ResponseMessage,
        { type: 'SETTINGS_RESPONSE' }
      >
      setSettings(res.settings)
    })()
    return () => emitMood(null)
  }, [])

  async function handleCheck() {
    if (!settings?.workerUrl || !settings.workerSecret) {
      setState('nokeys')
      return
    }
    setState('loading')
    setReason('')
    emitMood(null)
    try {
      const res = await runMatch(settings)
      if (res.match) {
        setMatch(res.match)
        emitMood(res.match.color)
        publishMatch(res.match)
        setState(res.match.lowConfidence ? 'lowconf' : 'found')
      } else {
        setMatch(null)
        publishMatch(null)
        setReason(res.reason ?? '')
        setState('notfound')
      }
    } catch (err) {
      setMatch(null)
      publishMatch(null)
      setReason(`match_error:${err}`)
      setState('notfound')
    }
  }

  if (state === 'idle') {
    return (
      <div>
        <p className="intro">{t('check.intro')}</p>
        <button className="btn btn-primary" onClick={handleCheck}>
          {t('check.button')}
        </button>
      </div>
    )
  }

  if (state === 'loading') {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <span>{t('check.loading')}</span>
      </div>
    )
  }

  if (state === 'nokeys') {
    return (
      <div>
        <p className="error-text">{t('check.noKeys')}</p>
        <button className="btn btn-ghost" onClick={() => setState('idle')} style={{ marginTop: 12 }}>
          ← back
        </button>
      </div>
    )
  }

  if (state === 'notfound') {
    return (
      <div>
        <p className="intro">{t('check.noMatch')}</p>
        {reason && <p className="hint">{friendlyReason(reason, t)}</p>}
        <button className="btn btn-ghost" onClick={() => setState('idle')} style={{ marginTop: 12 }}>
          ← back
        </button>
      </div>
    )
  }

  if ((state === 'found' || state === 'lowconf') && match && settings) {
    return <ResultView match={match} settings={settings} onBack={() => { emitMood(null); setState('idle') }} />
  }

  return null
}

function friendlyReason(reason: string, t: (k: string) => string): string {
  if (reason.startsWith('no_keys')) return t('check.noKeys')
  if (reason.startsWith('no_article')) return t('errors.extractFailed')
  if (reason.startsWith('below_floor')) return 'No market is close enough to this article. Try lowering the confidence threshold in Settings, or wait — the market cache may still be loading.'
  if (reason.startsWith('match_error')) return reason.replace('match_error:', 'Match error: ')
  return reason
}

function ResultView({
  match,
  settings,
  onBack,
}: {
  match: MatchResult
  settings: SettingsT
  onBack: () => void
}) {
  const { t } = useTranslation()
  const prob = match.freshPrice ?? match.probability
  const pct = Math.round(prob * 100)
  const url = buildMarketUrl(match.market.slug)
  const onClickout = () => {
    void trackEvent('match_clicked', settings, { color: match.color })
  }

  return (
    <div>
      {match.lowConfidence && (
        <div className="low-conf-pill">{t('check.lowConfidenceTitle')}</div>
      )}
      <div className="match-card" data-mood={match.color}>
        <div className="match-meta">
          <span className={`dot dot-${match.color}`} />
          <span>{t('check.marketOdds')}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-mute)' }}>
            match {Math.round(match.confidence * 100)}%
          </span>
        </div>
        <p className="match-question">{match.market.question}</p>
        <p className={`match-pct match-color-${match.color}`}>{pct}%</p>
        <div className="match-sub">
          {t('check.chance')}
          {match.market.volume > 0 &&
            ` · ${t('check.volume', { amount: formatVolume(match.market.volume) })}`}
        </div>
        <div className="bar-wrap">
          <div
            className="bar"
            style={{
              width: `${pct}%`,
              backgroundColor: dotColor(match.color),
              color: dotColor(match.color),
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <a
            className="link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClickout}
          >
            {t('check.viewOnPolymarket')}
          </a>
          <button
            className="link"
            onClick={() => switchTab('trade')}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {t('trade.title')} →
          </button>
        </div>
      </div>

      {match.alternatives.length > 0 && (
        <div className="alternatives">
          <div className="section-title">
            {match.lowConfidence ? t('check.alternatives') : 'Other related markets'}
          </div>
          {match.alternatives.map((alt, i) => {
            const score = match.alternativeScores?.[i]
            return (
              <a
                key={alt.id}
                className="alt-item"
                href={buildMarketUrl(alt.slug)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ flex: 1 }}>{alt.question}</span>
                  {score !== undefined && (
                    <span style={{ color: 'var(--text-mute)', fontSize: 10, flexShrink: 0 }}>
                      {Math.round(score * 100)}%
                    </span>
                  )}
                </div>
              </a>
            )
          })}
        </div>
      )}

      {/* Trade tab is rendered separately in App.tsx — wallet-gated, not here. */}

      <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 12 }}>
        ← back
      </button>
    </div>
  )
}

function dotColor(c: MatchColor): string {
  // Mirror the CSS --blue/--yellow/--red variables in src/popup/styles.css
  switch (c) {
    case 'blue':   return '#1F7BD9'
    case 'yellow': return '#C77A14'
    case 'red':    return '#D33A38'
  }
}

/**
 * Volume comes from Polymarket as a USD float (not a count of traders).
 * Render as compact currency: 1.2M / 340k / 1,200.
 */
function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`
  return Math.round(v).toLocaleString('en-US')
}
