import { useTranslation } from 'react-i18next'

interface Props {
  country?: string
}

export function GeoBlock({ country }: Props) {
  const { t } = useTranslation()
  return (
    <div className="warning" style={{ marginTop: 0 }}>
      {t('trade.geoBlocked')}
      {country && (
        <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>
          Detected: {country}
        </div>
      )}
    </div>
  )
}
