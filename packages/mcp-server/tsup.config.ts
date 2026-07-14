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
  },
})
