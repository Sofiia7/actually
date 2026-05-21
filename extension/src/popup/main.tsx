import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from '../i18n'
import { sendToBackground } from '../shared/messages'
import type { ResponseMessage } from '../shared/messages'

async function bootstrap() {
  const res = (await sendToBackground({ type: 'GET_SETTINGS' })) as Extract<
    ResponseMessage,
    { type: 'SETTINGS_RESPONSE' }
  >
  initI18n(res?.settings?.locale)
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
