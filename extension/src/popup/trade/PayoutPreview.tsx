import { useTranslation } from 'react-i18next'

interface Props {
  sizeUsd: number
  price: number
  /** 0..1, e.g. 0.05 = 5% estimated slippage */
  slippage?: number | null
}

/**
 * Pure-render payout summary. Shares = sizeUsd / price. Max payout if the
 * outcome resolves YES = shares × $1. Return % is (max - size) / size.
 */
export function PayoutPreview({ sizeUsd, price, slippage }: Props) {
  const { t } = useTranslation()
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !Number.isFinite(price) || price <= 0) {
    return null
  }
  const shares = sizeUsd / price
  const maxPayout = shares
  const ret = (maxPayout - sizeUsd) / sizeUsd

  return (
    <div
      style={{
        marginTop: 10,
        padding: '10px 12px',
        background: 'var(--bg-tint)',
        border: '1px solid var(--border-soft)',
        borderRadius: 10,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <Row label={t('trade.maxPayout')} value={`$${maxPayout.toFixed(2)}`} />
      <Row label={t('trade.returnPct')} value={`+${(ret * 100).toFixed(0)}%`} />
      {slippage != null && slippage > 0 && (
        <Row
          label={t('trade.slippage')}
          value={`${(slippage * 100).toFixed(1)}%`}
          danger={slippage > 0.05}
        />
      )}
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-mute)' }}>{label}</span>
      <span
        style={{
          fontWeight: 600,
          color: danger ? 'var(--warn)' : 'var(--text)',
          fontFeatureSettings: '"tnum"',
        }}
      >
        {value}
      </span>
    </div>
  )
}
