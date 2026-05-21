import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PolyMarket } from '../../shared/types'
import { placeOrder, type WalletState } from '../../background/trade'
import { PayoutPreview } from './PayoutPreview'

interface Props {
  market: PolyMarket & { negRisk?: boolean }
  state: WalletState
  /** Current best ask, 0..1 USDC per share, for the chosen outcome. */
  price: number | null
}

type Side = 'BUY_YES' | 'BUY_NO'

/**
 * Side toggle, USD size input, payout preview, submit.
 *
 * For v1 we only support BUY of YES or NO outcomes (no SELL — opening a
 * position only). Closing positions is deferred to v1.x.
 */
export function OrderForm({ market, state, price }: Props) {
  const { t } = useTranslation()
  const [side, setSide] = useState<Side>('BUY_YES')
  const [sizeUsd, setSizeUsd] = useState(20)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // YES / NO map to the first / second clobTokenIds entry in the Gamma payload.
  const tokenId = side === 'BUY_YES' ? market.clobTokenIds[0] : market.clobTokenIds[1]
  const effectivePrice = price ?? null

  async function onSubmit() {
    if (!tokenId || !effectivePrice) return
    setSubmitting(true)
    setResult(null)
    try {
      const r = await placeOrder({
        state,
        tokenId,
        side,
        sizeUsd,
        price: effectivePrice,
        negRisk: market.negRisk ?? false,
      })
      if (r.ok) {
        setResult({ ok: true, msg: t('trade.success') })
      } else {
        setResult({ ok: false, msg: t('trade.failure', { reason: r.error ?? 'unknown' }) })
      }
    } catch (err) {
      setResult({ ok: false, msg: t('trade.failure', { reason: String(err) }) })
    } finally {
      setSubmitting(false)
    }
  }

  const disabled =
    submitting ||
    !tokenId ||
    !effectivePrice ||
    !Number.isFinite(sizeUsd) ||
    sizeUsd <= 0

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button
          className={`btn ${side === 'BUY_YES' ? 'btn-primary' : ''}`}
          onClick={() => setSide('BUY_YES')}
        >
          {t('trade.buyYes')}
        </button>
        <button
          className={`btn ${side === 'BUY_NO' ? 'btn-primary' : ''}`}
          onClick={() => setSide('BUY_NO')}
        >
          {t('trade.buyNo')}
        </button>
      </div>

      <div className="field">
        <label>{t('trade.amount')}</label>
        <input
          type="number"
          min={1}
          step={1}
          value={sizeUsd}
          onChange={(e) => setSizeUsd(Number(e.target.value))}
        />
      </div>

      {effectivePrice != null && (
        <PayoutPreview sizeUsd={sizeUsd} price={effectivePrice} />
      )}

      <button
        className="btn btn-primary"
        onClick={onSubmit}
        disabled={disabled}
        style={{ marginTop: 12 }}
      >
        {submitting ? t('trade.submitting') : t('trade.placeOrder')}
      </button>

      {result && (
        <div
          className={result.ok ? 'hint' : 'error-text'}
          style={{ marginTop: 8, color: result.ok ? 'var(--ok)' : undefined }}
        >
          {result.msg}
        </div>
      )}
    </div>
  )
}
