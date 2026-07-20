import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'
import { resolvePublishDefaults } from './src/publishDefaults'

// Baked defaults — see src/publishDefaults.ts for the full rules. Key
// properties: a `npm publish` (prepublishOnly) build FAILS if the worker
// url/secret resolve empty (0.1.0 shipped exactly that way — dead zero-setup
// tools); worker values fall back to extension/.env.local; the builder code
// is env-var-only and never inherited implicitly (open ToS question R1).
let envLocalText: string | undefined
try {
  envLocalText = readFileSync(join(__dirname, '..', '..', 'extension', '.env.local'), 'utf8')
} catch {
  envLocalText = undefined // CI / fresh checkout — fine for non-publish builds
}

const {
  builderCode: BUILDER_CODE,
  workerUrl: DEFAULT_WORKER_URL,
  workerSecret: DEFAULT_WORKER_SECRET,
} = resolvePublishDefaults({
  env: process.env,
  envLocalText,
  isPublish: process.env.npm_lifecycle_event === 'prepublishOnly',
})

// Baked in so the McpServer's reported version can never drift from what
// actually gets published (see src/config.ts's PKG_VERSION / src/version.test.ts
// — 0.1.0 and 0.1.1 both shipped with a hand-edited literal that fell out
// of sync with this file).
const PKG_VERSION = (JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as { version: string })
  .version

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // @actually/core is a private workspace package, never published — it MUST
  // be bundled into dist/index.js, not left as an external import.
  noExternal: ['@actually/core'],
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __BUILDER_CODE__: JSON.stringify(BUILDER_CODE),
    __DEFAULT_WORKER_URL__: JSON.stringify(DEFAULT_WORKER_URL),
    __DEFAULT_WORKER_SECRET__: JSON.stringify(DEFAULT_WORKER_SECRET),
    __PKG_VERSION__: JSON.stringify(PKG_VERSION),
  },
})
