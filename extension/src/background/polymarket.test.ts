import { describe, expect, it } from 'vitest'
import { buildMarketUrl } from './polymarket'

describe('buildMarketUrl', () => {
  it('appends utm_source=actually to the slug', () => {
    expect(buildMarketUrl('will-x-happen')).toBe(
      'https://polymarket.com/event/will-x-happen?utm_source=actually',
    )
  })

  it('does not crash on empty slug', () => {
    expect(buildMarketUrl('')).toContain('utm_source=actually')
  })
})
