import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { connectWallet, disconnectWallet, type WalletState } from '../../background/trade'

interface Props {
  state: WalletState | null
  onChange: (s: WalletState | null) => void
}

export function ConnectButton({ state, onChange }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [uri, setUri] = useState<string | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!uri) {
      setQrSvg(null)
      return
    }
    QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 })
      .then(setQrSvg)
      .catch(() => setQrSvg(null))
  }, [uri])

  async function onConnect() {
    setBusy(true)
    setError(null)
    setUri(null)
    try {
      const result = await connectWallet({
        onUri: (u) => setUri(u),
      })
      onChange(result)
      setUri(null)
    } catch (err) {
      setError(humanError(String(err)))
    } finally {
      setBusy(false)
    }
  }

  async function onDisconnect() {
    setBusy(true)
    try {
      await disconnectWallet(state)
      onChange(null)
    } finally {
      setBusy(false)
    }
  }

  if (state) {
    return (
      <div className="match-card" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="match-meta">
          <span className="dot dot-blue" />
          {t('trade.connected', { address: shorten(state.address) })}
        </div>
        <button className="btn btn-ghost" onClick={onDisconnect} disabled={busy}>
          {t('trade.disconnect')}
        </button>
      </div>
    )
  }

  if (uri) {
    return (
      <div className="match-card" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="hint" style={{ marginBottom: 8 }}>
          {t('trade.connecting')}
        </div>
        {qrSvg && (
          <div
            style={{ display: 'flex', justifyContent: 'center', padding: 8 }}
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        )}
        <a
          className="btn btn-primary"
          href={uri}
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 8 }}
        >
          Open in wallet
        </a>
      </div>
    )
  }

  return (
    <>
      <button className="btn btn-primary" onClick={onConnect} disabled={busy}>
        {busy ? '…' : t('trade.connectWallet')}
      </button>
      {error && <div className="error-text" style={{ marginTop: 8, fontSize: 11 }}>{error}</div>}
    </>
  )
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function humanError(raw: string): string {
  if (raw.includes('wc_project_id_missing')) return 'WalletConnect project ID not configured. See README.'
  if (raw.includes('builder_code_not_configured')) return 'Builder code missing in build.'
  if (raw.includes('geo_blocked')) return 'Trading is not available in your region.'
  if (raw.includes('worker_not_configured')) return 'Set Worker URL and secret in Settings first.'
  if (raw.includes('funder_not_found')) return 'No Polymarket Safe found for this wallet. Sign in on polymarket.com once, then retry.'
  return raw.replace(/^Error: /, '')
}
