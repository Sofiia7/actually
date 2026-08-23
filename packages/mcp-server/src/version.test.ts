import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('version sync', () => {
  it('PKG_VERSION falls back to package.json when __PKG_VERSION__ is not baked in (dev/test) - 0.1.0 and 0.1.1 both shipped with a hand-edited literal that drifted out of sync', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    const { PKG_VERSION } = await import('./config')
    expect(PKG_VERSION).toBe(pkg.version)
  })
})
