import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Enables RTL auto-cleanup between component tests (unmounts the DOM so
    // renders don't accumulate across tests).
    globals: true,
    // Component tests (*.test.tsx) run under jsdom; everything else stays node.
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/test/setup.ts'],
    // Build-time config the wallet/order paths read from import.meta.env.
    // Pinned here so the suite is hermetic: without it, tests that reach
    // connectWallet or startConnect pass on a maintainer's machine (which has
    // extension/.env.local) and fail everywhere else with
    // `builder_code_not_configured` / `wc_project_id_missing`. A test whose
    // result depends on an untracked local file is not a test.
    // Values are deliberately fake — nothing here talks to a real service.
    env: {
      VITE_BUILDER_CODE: `0x${'0'.repeat(64)}`,
      VITE_WC_PROJECT_ID: 'test-wc-project-id',
    },
    include: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts'],
    // The popup imports chrome.* directly and pulls heavy WASM (transformers,
    // ethers' shims) which slow vitest to a crawl. Tests focus on pure
    // helpers — matcher math, URL builders, util, geo logic, cache diff.
    // UI components are excluded; they're verified by manual extension reload.
    exclude: ['node_modules/**', 'dist/**', 'src/popup/**', 'src/background/embeddings.ts'],
  },
})
