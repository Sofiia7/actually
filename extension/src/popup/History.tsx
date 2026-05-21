import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'
import type { HistoryItem } from '../shared/types'
import { buildMarketUrl } from '../background/polymarket'

export function History() {
  const { t } = useTranslation()
  const [items, setItems] = useState<HistoryItem[]>([])

  useEffect(() => { void load() }, [])

  async function load() {
    const res = (await sendToBackground({ type: 'GET_HISTORY' })) as Extract<
      ResponseMessage,
      { type: 'HISTORY_RESPONSE' }
    >
    setItems(res.items)
  }

  async function onClear() {
    await sendToBackground({ type: 'CLEAR_HISTORY' })
    setItems([])
  }

  if (items.length === 0) {
    return <p className="intro">{t('history.empty')}</p>
  }

  return (
    <div>
      <div className="section-title">{t('history.title')}</div>
      {items.map((it) => (
        <a
          key={it.timestamp}
          className="history-item"
          href={buildMarketUrl(it.marketSlug)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`dot dot-${it.color}`} />
            <strong style={{ fontWeight: 600 }}>{Math.round(it.probability * 100)}%</strong>
          </div>
          <div className="history-question">{it.question}</div>
          <div className="history-domain">{it.pageDomain}</div>
        </a>
      ))}
      <button className="btn btn-ghost btn-danger" onClick={onClear} style={{ marginTop: 12 }}>
        {t('history.clear')}
      </button>
    </div>
  )
}
