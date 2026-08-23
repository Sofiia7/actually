import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * Load `.md` as a default-export string, matching how Wrangler bundles it for
 * the Worker (the [[rules]] type = "Text" block in worker/wrangler.toml).
 *
 * The Worker imports the privacy policy directly so the published page and
 * the repo file cannot drift. Without this plugin the whole worker suite
 * fails to import - vite tries to parse the markdown as JavaScript.
 */
function textModules() {
  return {
    name: 'text-markdown-modules',
    load(id: string) {
      if (!id.endsWith('.md')) return null
      return `export default ${JSON.stringify(readFileSync(id.split('?')[0], 'utf8'))}`
    },
  }
}

export default defineConfig({
  plugins: [textModules()],
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
    // Values are deliberately fake - nothing here talks to a real service.
    env: {
      VITE_BUILDER_CODE: `0x${'0'.repeat(64)}`,
      VITE_WC_PROJECT_ID: 'test-wc-project-id',
    },
    include: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts'],
    // The popup imports chrome.* directly and pulls heavy WASM (transformers,
    // ethers' shims) which slow vitest to a crawl. Tests focus on pure
    // helpers - matcher math, URL builders, util, geo logic, cache diff.
    // UI components are excluded; they're verified by manual extension reload.
    exclude: ['node_modules/**', 'dist/**', 'src/popup/**', 'src/background/embeddings.ts'],
  },
})
