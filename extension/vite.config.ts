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
