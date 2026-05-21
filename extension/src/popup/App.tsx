import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckPage } from './CheckPage'
import { History } from './History'
import { Settings } from './Settings'
import { TradePanel } from './TradePanel'
import type { MatchColor, MatchResult } from '../shared/types'

type Tab = 'check' | 'trade' | 'history' | 'settings'

/**
 * Custom-event channel between CheckPage and App.
 *   actually:mood   — set the ambient background mood
 *   actually:match  — publish the current matched market for Trade tab
 *   actually:tab    — request switching the active tab (e.g. "Trade this market")
 */
export function App() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('check')
  const [mood, setMood] = useState<MatchColor | null>(null)
  const [match, setMatch] = useState<MatchResult | null>(null)

  useEffect(() => {
    const onMood = (e: Event) => {
      setMood(((e as CustomEvent).detail as MatchColor | null) ?? null)
    }
    const onMatch = (e: Event) => {
      setMatch(((e as CustomEvent).detail as MatchResult | null) ?? null)
    }
    const onTab = (e: Event) => {
      const want = (e as CustomEvent).detail as Tab
      if (want === 'check' || want === 'trade' || want === 'history' || want === 'settings') {
        setTab(want)
      }
    }
    window.addEventListener('actually:mood', onMood as EventListener)
    window.addEventListener('actually:match', onMatch as EventListener)
    window.addEventListener('actually:tab', onTab as EventListener)
    return () => {
      window.removeEventListener('actually:mood', onMood as EventListener)
      window.removeEventListener('actually:match', onMatch as EventListener)
      window.removeEventListener('actually:tab', onTab as EventListener)
    }
  }, [])

  return (
    <div className="app" data-mood={mood ?? undefined}>
      <div className="header">
        <span className="brand">{t('app.name')}</span>
        <span className="tagline">{t('app.tagline')}</span>
      </div>
      <div className="tabs">
        {(['check', 'trade', 'history', 'settings'] as Tab[]).map((k) => (
          <button
            key={k}
            className={`tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      <div className="panel">
        {tab === 'check' && <CheckPage />}
        {tab === 'trade' && <TradePanel match={match} />}
        {tab === 'history' && <History />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  )
}
