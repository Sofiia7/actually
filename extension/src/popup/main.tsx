import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../popup_new/fonts.css'
import '../popup_new/styles.css'
import { IntegratedPopup } from '../popup_new/IntegratedPopup'

// IntegratedPopup loads its own settings on mount. The popup UI is
// English-only in v1 (i18n removed), so there is no locale bootstrap here.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IntegratedPopup />
  </StrictMode>,
)
