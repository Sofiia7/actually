import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearConnectLog,
  formatConnectLog,
  getConnectLog,
  logConnect,
  redact,
} from './connectLog'

beforeEach(async () => {
  await clearConnectLog()
})

describe('redact', () => {
  it('never lets a WalletConnect pairing URI reach storage', () => {
    // The URI carries the session's symmetric key — it is a live credential,
    // not an identifier.
    const out = redact('connecting with wc:a1b2c3@2?relay-protocol=irn&symKey=deadbeef')
    expect(out).not.toContain('symKey')
    expect(out).toContain('<uri redacted>')
  })

  it('truncates addresses and hashes instead of recording them whole', () => {
    expect(redact('signer 0xabcdef0123456789abcdef0123456789abcdef01')).toBe(
      'signer 0xabcd…ef01',
    )
  })

  it('caps runaway values', () => {
    expect(redact('x'.repeat(1000)).length).toBeLessThanOrEqual(301)
  })

  it('handles non-string input without throwing', () => {
    expect(redact(new Error('boom'))).toContain('boom')
    expect(redact(undefined)).toBe('undefined')
  })
})

describe('connect log', () => {
  it('records steps in order and survives being read back', async () => {
    await logConnect('start')
    await logConnect('uri_ready')
    await logConnect('approved', 'topic 0xabcdef0123456789')
    const entries = await getConnectLog()
    expect(entries.map((e) => e.step)).toEqual(['start', 'uri_ready', 'approved'])
    expect(entries[2].detail).toContain('…')
  })

  it('keeps the buffer bounded so diagnostics can never grow without limit', async () => {
    for (let i = 0; i < 80; i++) await logConnect(`step_${i}`)
    const entries = await getConnectLog()
    expect(entries.length).toBe(60)
    expect(entries[entries.length - 1].step).toBe('step_79')
  })

  it('formats relative timings for the copy button', async () => {
    await logConnect('start')
    await logConnect('done')
    const text = formatConnectLog(await getConnectLog())
    expect(text).toContain('start')
    expect(text).toContain('done')
    expect(text).toMatch(/\+0\.0s/)
  })

  it('says so plainly when nothing has been recorded', () => {
    expect(formatConnectLog([])).toBe('No connect attempts recorded yet.')
  })
})
