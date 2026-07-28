import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }

/**
 * Tighten manifest CSP at build time. The committed manifest.json carries a
 * permissive `https://*.workers.dev` in `connect-src` so the dev unpacked
 * build works out of the box — but for production we replace that wildcard
 * with the exact Worker host pinned via `VITE_WORKER_URL`. Any CWS reviewer
 * looking at the shipped manifest then sees one concrete origin.
 *
 * Falls back to the wildcard when no VITE_WORKER_URL is set (dev mode).
 */
function tightenConnectSrc(workerUrl: string | undefined): typeof manifest {
  if (!workerUrl) return manifest
  let host: string
  try {
    host = new URL(workerUrl).origin
  } catch {
    return manifest
  }
  const csp = manifest.content_security_policy
  if (!csp?.extension_pages) return manifest
  const next = csp.extension_pages.replace(/https:\/\/\*\.workers\.dev/g, host)
  return {
    ...manifest,
    content_security_policy: { ...csp, extension_pages: next },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const finalManifest = tightenConnectSrc(env.VITE_WORKER_URL)

  return {
    plugins: [react(), crx({ manifest: finalManifest })],
    build: {
      target: 'es2022',
      // Wipe dist/ on each build so stale hashed chunks (potentially carrying
      // an old baked secret) never linger into a release artifact.
      emptyOutDir: true,
      // Vite's default modulepreload polyfill/dynamic-import-preload helper
      // touches `document.head`/`document.querySelectorAll` — meaningless in
      // an MV3 service worker (no DOM at all) and in a 360px popup/offscreen
      // page it buys nothing. Worse than useless here: the background entry
      // ends up sharing a chunk with this helper (pulled in transitively via
      // embeddings.ts's dynamic `import('@xenova/transformers')`), and the
      // helper's own "no document? stub one" fallback only stubs
      // createElement/documentElement/head — not querySelectorAll — so the
      // service worker crashes on its very first evaluation with
      // "Service worker registration failed. Status code: 15" (script
      // evaluation error) the instant that shared chunk is imported.
      modulePreload: false,
      rollupOptions: {
        // Popup is declared in manifest as default_popup; offscreen is
        // created at runtime via chrome.offscreen.createDocument. Both must
        // be listed here as extra HTML entries so Vite emits them.
        input: {
          offscreen: 'src/offscreen/offscreen.html',
          popup: 'src/popup/index.html',
        },
        output: {
          chunkFileNames: 'assets/[name]-[hash].js',
        },
      },
    },
    server: { port: 5173, strictPort: true },
  }
})