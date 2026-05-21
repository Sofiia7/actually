import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The popup imports chrome.* directly and pulls heavy WASM (transformers,
    // ethers' shims) which slow vitest to a crawl. Tests focus on pure
    // helpers — matcher math, URL builders, util, geo logic, cache diff.
    // UI components are excluded; they're verified by manual extension reload.
    exclude: ['node_modules/**', 'dist/**', 'src/popup/**', 'src/background/embeddings.ts'],
  },
})
