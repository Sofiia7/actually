import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: ['@actually/core'],
  banner: { js: '#!/usr/bin/env node' },
})
