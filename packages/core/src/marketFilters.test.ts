import { describe, expect, it } from 'vitest'
import { isNoiseMarket } from './marketFilters'

describe('isNoiseMarket', () => {
  it('flags "will X say" word-association markets', () => {
    expect(isNoiseMarket('Will Trump say "tremendous" during the speech?')).toBe(true)
  })

  it('flags "will X mention" markets', () => {
    expect(isNoiseMarket('Will Biden mention inflation in the address?')).toBe(true)
  })

  it('flags "word of the day/week" markets', () => {
    expect(isNoiseMarket('Word of the day: will it be "chaos"?')).toBe(true)
  })

  it('does not flag a real outcome question', () => {
    expect(isNoiseMarket('Will Iran enrich uranium past 60% by July?')).toBe(false)
  })
})
