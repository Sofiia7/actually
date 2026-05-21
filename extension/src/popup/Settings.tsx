import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'
import type {
  EmbeddingProvider,
  Settings as SettingsT,
  SupportedLocale,
  TestKeysResult,
} from '../shared/types'
import { runRefresh } from './operations'
import { getCacheStatus } from '../background/cache'
import { BUILDER_CODE, defaultThresholds } from '../shared/constants'

export function Settings() {
  const { t, i18n } = useTranslation()
  const [s, setS] = useState<SettingsT | null>(null)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestKeysResult | null>(null)
  const [cache, setCache] = useState<{ count: number; lastUpdated: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string>('')

  useEffect(() => {
    void load()
    // Poll cache status every 2s while popup is open (so progress shows live)
    const id = setInterval(() => { void pollCache() }, 2000)
    return () => clearInterval(id)
  }, [])

  async function load() {
    const res = (await sendToBackground({ type: 'GET_SETTINGS' })) as Extract<
      ResponseMessage,
      { type: 'SETTINGS_RESPONSE' }
    >
    setS(res.settings)
    await pollCache()
    // Auto-refresh on first open if cache is empty and keys are present
    if (
      res.settings.workerUrl &&
      res.settings.workerSecret &&
      !refreshing
    ) {
      const c = await getCacheStatus()
      if (c.count === 0) void refreshNow(res.settings)
    }
  }

  async function pollCache() {
    const c = await getCacheStatus()
    setCache({ count: c.count, lastUpdated: c.lastUpdated })
  }

  async function refreshNow(forced?: SettingsT) {
    const cur = forced ?? s
    if (!cur) return
    setRefreshError('')
    setRefreshing(true)
    try {
      await runRefresh(cur)
    } catch (err) {
      setRefreshError(String(err))
    } finally {
      setRefreshing(false)
      await pollCache()
    }
  }

  async function save(patch: Partial<SettingsT>) {
    if (!s) return
    const res = (await sendToBackground({ type: 'SAVE_SETTINGS', settings: patch })) as Extract<
      ResponseMessage,
      { type: 'SETTINGS_RESPONSE' }
    >
    setS(res.settings)
    if (patch.locale) await i18n.changeLanguage(patch.locale)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function test() {
    setTesting(true)
    const res = (await sendToBackground({ type: 'TEST_KEYS' })) as Extract<
      ResponseMessage,
      { type: 'TEST_KEYS_RESULT' }
    >
    setTestResult(res.result)
    setTesting(false)
  }

  if (!s) return <p className="intro">loading…</p>

  return (
    <div>
      {/* API & connection */}
      <div className="section-title">{t('settings.apiKeys')}</div>

      <div className="field">
        <label>{t('settings.workerUrl')}</label>
        <input
          type="url"
          value={s.workerUrl}
          placeholder="https://actually-api.<you>.workers.dev"
          onChange={(e) => setS({ ...s, workerUrl: e.target.value })}
          onBlur={() => save({ workerUrl: s.workerUrl })}
        />
      </div>

      <div className="field">
        <label>{t('settings.workerSecret')}</label>
        <input
          type="password"
          value={s.workerSecret}
          onChange={(e) => setS({ ...s, workerSecret: e.target.value })}
          onBlur={() => save({ workerSecret: s.workerSecret })}
        />
      </div>

      <div className="field">
        <label>{t('settings.embeddingProvider')}</label>
        <select
          value={s.embeddingProvider}
          onChange={(e) => save({ embeddingProvider: e.target.value as EmbeddingProvider })}
        >
          <option value="local">{t('settings.providerLocal')}</option>
          <option value="openai">{t('settings.providerOpenAI')}</option>
        </select>
      </div>

      {s.embeddingProvider === 'openai' && (
        <div className="hint">{t('settings.openaiServerHint')}</div>
      )}

      <button className="btn" disabled={testing} onClick={test}>
        {testing ? '…' : t('settings.test')}
      </button>
      {testResult && (
        <div className="hint" style={{ marginTop: 6 }}>
          Worker: {testResult.worker.ok ? '✓' : `✗ ${testResult.worker.error}`}{' '}
          {testResult.openai && (
            <>· OpenAI: {testResult.openai.ok ? '✓' : `✗ ${testResult.openai.error}`}</>
          )}
        </div>
      )}

      {/* Behavior */}
      <div className="section-title">{t('settings.behavior')}</div>

      {(() => {
        const rec = defaultThresholds(s.embeddingProvider)
        const showRecT = Math.abs(s.confidenceThreshold - rec.confidenceThreshold) > 0.005
        const showRecF = Math.abs(s.lowConfidenceFloor - rec.lowConfidenceFloor) > 0.005
        return (
          <>
            <div className="field">
              <label>
                {t('settings.confidence')}: {s.confidenceThreshold.toFixed(2)}
                {showRecT && (
                  <button
                    onClick={() => save({ confidenceThreshold: rec.confidenceThreshold })}
                    style={{
                      marginLeft: 8, background: 'none', border: 'none',
                      color: 'var(--accent)', fontSize: 10, cursor: 'pointer', padding: 0,
                    }}
                  >
                    use {rec.confidenceThreshold.toFixed(2)} (recommended)
                  </button>
                )}
              </label>
              <input
                type="range" min={0.20} max={0.95} step={0.01}
                value={s.confidenceThreshold}
                onChange={(e) => setS({ ...s, confidenceThreshold: Number(e.target.value) })}
                onMouseUp={() => save({ confidenceThreshold: s.confidenceThreshold })}
              />
            </div>

            <div className="field">
              <label>
                {t('settings.lowConfidenceFloor')}: {s.lowConfidenceFloor.toFixed(2)}
                {showRecF && (
                  <button
                    onClick={() => save({ lowConfidenceFloor: rec.lowConfidenceFloor })}
                    style={{
                      marginLeft: 8, background: 'none', border: 'none',
                      color: 'var(--accent)', fontSize: 10, cursor: 'pointer', padding: 0,
                    }}
                  >
                    use {rec.lowConfidenceFloor.toFixed(2)} (recommended)
                  </button>
                )}
              </label>
              <input
                type="range" min={0.10} max={0.80} step={0.01}
                value={s.lowConfidenceFloor}
                onChange={(e) => setS({ ...s, lowConfidenceFloor: Number(e.target.value) })}
                onMouseUp={() => save({ lowConfidenceFloor: s.lowConfidenceFloor })}
              />
            </div>
          </>
        )
      })()}

      {cache && (
        <div style={{ marginTop: 10, marginBottom: 4 }}>
          <div className="hint" style={{ marginBottom: 6 }}>
            Cache: {cache.count} markets
            {cache.lastUpdated > 0 && ` · ${Math.round((Date.now() - cache.lastUpdated) / 60000)}m ago`}
            {refreshing && ' · refreshing…'}
          </div>
          <button className="btn btn-ghost" onClick={() => refreshNow()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh markets now'}
          </button>
          {refreshError && <div className="error-text" style={{ fontSize: 11, marginTop: 6 }}>Refresh failed: {refreshError}</div>}
        </div>
      )}

      <div className="field">
        <label>{t('settings.locale')}</label>
        <select
          value={s.locale}
          onChange={(e) => save({ locale: e.target.value as SupportedLocale })}
        >
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="pt-BR">Português (BR)</option>
        </select>
      </div>

      {/* Privacy */}
      <div className="section-title">{t('settings.privacy')}</div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={s.telemetryEnabled}
          onChange={(e) => save({ telemetryEnabled: e.target.checked })}
        />
        {t('settings.telemetry')}
      </label>
      <div className="hint">{t('settings.telemetryHint')}</div>

      <div className="section-title">{t('settings.about')}</div>
      <div className="hint">
        {t('settings.version', { version: chrome.runtime.getManifest().version })}
      </div>
      {BUILDER_CODE && (
        <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
          {t('settings.builderCodeReadOnly')}: <code>{BUILDER_CODE}</code>
        </div>
      )}

      {saved && <div className="hint" style={{ color: 'var(--ok)', marginTop: 8 }}>{t('settings.saved')}</div>}
    </div>
  )
}
