import { defineConfig } from 'tsup'

// Baked at publish time — set ACTUALLY_BUILDER_CODE in the release environment
// before running `npm run build`. Empty string disables place_order/prepare_order
// entirely (see src/config.ts), so a build with no code set ships signal-only.
const BUILDER_CODE = process.env.ACTUALLY_BUILDER_CODE ?? ''

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
  },
})
