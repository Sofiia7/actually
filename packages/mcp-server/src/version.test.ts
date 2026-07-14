import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('version sync', () => {
  it('serverInfo version literal in index.ts matches package.json (0.1.0 shipped with a mismatch)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(src).toContain(`version: '${pkg.version}'`)
  })
})
