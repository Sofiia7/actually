import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import es from './es.json'
import ptBR from './pt-BR.json'
import type { SupportedLocale } from '../shared/types'

const resources = {
  en: { translation: en },
  es: { translation: es },
  'pt-BR': { translation: ptBR },
}

export function detectLocale(): SupportedLocale {
  const nav = navigator.language || 'en'
  if (nav.startsWith('pt')) return 'pt-BR'
  if (nav.startsWith('es')) return 'es'
  return 'en'
}

export function initI18n(locale?: SupportedLocale): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng: locale ?? detectLocale(),
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    })
  } else if (locale && i18n.language !== locale) {
    void i18n.changeLanguage(locale)
  }
  return i18n
}

export default i18n
