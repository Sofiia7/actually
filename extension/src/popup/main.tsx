import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../popup_new/fonts.css'
import '../popup_new/styles.css'
import { IntegratedPopup } from '../popup_new/IntegratedPopup'
import { ensureFrostTexture } from '../popup_new/frost'

// IntegratedPopup loads its own settings on mount. The popup UI is
// English-only in v1 (i18n removed), so there is no locale bootstrap here.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IntegratedPopup />
  </StrictMode>,
)

// Paint/restore the frost texture AFTER first render so it never blocks the
// popup from appearing - the heavy canvas paint previously froze the popup on
// open. Cached in localStorage, so it is generated at most once.
setTimeout(() => ensureFrostTexture(), 0)
