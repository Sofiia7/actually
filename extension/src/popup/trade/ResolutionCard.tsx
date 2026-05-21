import { useTranslation } from 'react-i18next'
import type { PolyMarket } from '../../shared/types'

interface Props {
  market: PolyMarket & {
    endDate?: string
    description?: string
    resolutionSource?: string
  }
}

/**
 * Compact resolution summary: when, where it gets resolved from, first
 * couple of lines of the market rules.
 */
export function ResolutionCard({ market }: Props) {
  const { t } = useTranslation()
  const m = market as PolyMarket & {
    endDate?: string
    description?: string
    resolutionSource?: string
  }
  const dt = m.endDate ? new Date(m.endDate) : null

  return (
    <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)' }}>
      {dt && (
        <div>
          <span style={{ color: 'var(--text-mute)' }}>{t('trade.resolves')}: </span>
          {formatDate(dt)}
        </div>
      )}
      {m.resolutionSource && (
        <div style={{ wordBreak: 'break-all' }}>
          <span style={{ color: 'var(--text-mute)' }}>{t('trade.resolutionSource')}: </span>
          {m.resolutionSource}
        </div>
      )}
      {m.description && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: 'var(--text-mute)' }}>{t('trade.rules')}: </span>
          {truncate(m.description, 160)}
        </div>
      )}
    </div>
  )
}

function formatDate(d: Date): string {
  const now = Date.now()
  const diff = d.getTime() - now
  const days = Math.round(diff / 86_400_000)
  const abs = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (days < 0) return `${abs} (closed)`
  if (days === 0) return `today (${abs})`
  if (days === 1) return `tomorrow (${abs})`
  if (days < 14) return `in ${days} days (${abs})`
  return abs
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n).trimEnd() + '…'
}
