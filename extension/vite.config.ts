import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }

/**
 * Tighten manifest CSP at build time. The committed manifest.json carries a
 * permissive `https://*.workers.dev` in `connect-src` so the dev unpacked
 * build works out of the box - but for production we replace that wildcard
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

/**
 * Every value here is baked into the bundle at build time and has no runtime
 * fallback - an empty one produces an extension that installs fine and then
 * does nothing: "Worker not configured" on Check, `wc_project_id_missing` on
 * connect, `builder_code_not_configured` on every order.
 *
 * Silence is the danger. A build with no env present succeeds, looks normal,
 * and only fails once it is loaded in a browser - which is exactly how a dead
 * build got shipped after a verification run that had moved .env.local aside.
 * CI supplies deliberate stub values for these, so requiring them non-empty
 * costs nothing there and makes an accidental env-less build impossible.
 */
const REQUIRED_BUILD_ENV = [
  'VITE_WORKER_URL',
  'VITE_WORKER_SECRET',
  'VITE_WC_PROJECT_ID',
  'VITE_BUILDER_CODE',
] as const

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (command === 'build') {
    const missing = REQUIRED_BUILD_ENV.filter((k) => !env[k]?.trim())
    if (missing.length > 0) {
      throw new Error(
        `Refusing to build without: ${missing.join(', ')}.\n` +
          'These are baked in at build time with no runtime fallback, so an\n' +
          'empty value ships an extension that loads and then does nothing.\n' +
          'Set them in extension/.env.local (or the environment) and rebuild.',
      )
    }
  }

  const finalManifest = tightenConnectSrc(env.VITE_WORKER_URL)

  return {
    plugins: [react(), crx({ manifest: finalManifest })],
    build: {
      target: 'es2022',
      // Wipe dist/ on each build so stale hashed chunks (potentially carrying
      // an old baked secret) never linger into a release artifact.
      emptyOutDir: true,
      // Vite's default modulepreload polyfill/dynamic-import-preload helper
      // touches `document.head`/`document.querySelectorAll` - meaningless in
      // an MV3 service worker (no DOM at all) and in a 360px popup/offscreen
      // page it buys nothing. Worse than useless here: the background entry
      // ends up sharing a chunk with this helper (pulled in transitively via
      // embeddings.ts's dynamic `import('@xenova/transformers')`), and the
      // helper's own "no document? stub one" fallback only stubs
      // createElement/documentElement/head - not querySelectorAll - so the
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
          /**
           * Keep React and @actually/core in chunks of their own, so the
           * service worker cannot end up importing the popup.
           *
           * Left to itself, rolldown parks individual `@actually/core`
           * modules (pricing.ts and friends) *inside* the popup entry chunk
           * and then has the shared core barrel import them back out of it.
           * That single edge drags the entire popup chunk - React DOM
           * included - into the service worker's static graph. React DOM
           * initializes on evaluation by calling
           * `document.createElement('div').setAttribute('oninput','return;')`,
           * there is no DOM in a worker, and Chrome reports the whole thing
           * as "Service worker registration failed. Status code: 15". The
           * popup then hangs on "loading..." forever, because the worker it
           * is waiting on never came up.
           *
           * Naming the two groups explicitly removes the edge: core lives in
           * one chunk with its own barrel, React lives in a chunk only the
           * pages import. `minSize: 0` stops rolldown from merging either
           * back into a neighbour on size grounds.
           *
           * This is not theoretical tidiness - it shipped broken in the
           * vite 5 -> 8 (rolldown) upgrade and nothing caught it, so
           * scripts/preflight.mjs now asserts the worker's graph is DOM-free
           * on the built artifact.
           */
          codeSplitting: {
            groups: [
              { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, minSize: 0 },
              { name: 'core', test: /[\\/]packages[\\/]core[\\/]/, minSize: 0 },
            ],
          },
        },
      },
    },
    server: { port: 5173, strictPort: true },
  }
})