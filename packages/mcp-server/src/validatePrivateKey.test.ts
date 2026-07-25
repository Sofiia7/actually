import { describe, expect, it } from 'vitest'
import { assertValidPrivateKeyShape } from './validatePrivateKey'

describe('assertValidPrivateKeyShape', () => {
  it('accepts a 0x-prefixed 64-hex-char key', () => {
    expect(() => assertValidPrivateKeyShape(`0x${'a'.repeat(64)}`)).not.toThrow()
  })

  it('accepts a bare 64-hex-char key without 0x', () => {
    expect(() => assertValidPrivateKeyShape('f'.repeat(64))).not.toThrow()
  })

  it('rejects a pasted seed phrase without echoing it in the error message', () => {
    const seedPhrase = 'spoon carbon hazard glue abandon panda velvet notice donor'
    let thrown: unknown
    try {
      assertValidPrivateKeyShape(seedPhrase)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).not.toContain(seedPhrase)
    expect(message).toContain('POLYMARKET_PRIVATE_KEY')
  })

  it('rejects a key with the wrong length', () => {
    expect(() => assertValidPrivateKeyShape('0xabc123')).toThrow('POLYMARKET_PRIVATE_KEY')
  })

  it('rejects a key with trailing whitespace', () => {
    expect(() => assertValidPrivateKeyShape(`0x${'a'.repeat(64)} `)).toThrow('POLYMARKET_PRIVATE_KEY')
  })
})
