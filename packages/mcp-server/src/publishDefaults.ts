/**
 * Resolves the publish-time baked defaults for tsup.config.ts.
 *
 * Why this exists: `prepublishOnly` re-runs `npm run build` at `npm publish`
 * time. Before this helper, a publish from a shell without ACTUALLY_WORKER_URL
 * / ACTUALLY_WORKER_SECRET silently baked empty strings — shipping a package
 * whose zero-setup tools (check_news / get_market) throw "not configured" for
 * every npx user. Now:
 *
 *  - worker url/secret: explicit env var → extension/.env.local (the
 *    maintainer's dev machine always has it; these are the SAME values the
 *    extension bakes, public by design) → empty.
 *  - a PUBLISH build (npm_lifecycle_event === 'prepublishOnly') with empty
 *    worker url/secret fails loudly instead of shipping a dead package.
 *    Ordinary dev/CI builds still tolerate empties (CI has no .env.local and
 *    the tests mock the store).
 *  - builder code: env var ONLY, never read from .env.local — whether to ship
 *    it in a public package is an explicit per-release decision (open
 *    Polymarket ToS question R1), not something to inherit silently.
 */

export interface PublishDefaults {
  builderCode: string
  workerUrl: string
  workerSecret: string
}

function fromEnvLocal(text: string | undefined, key: string): string {
  if (!text) return ''
  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
}

export function resolvePublishDefaults(opts: {
  env: Record<string, string | undefined>
  envLocalText?: string
  isPublish: boolean
}): PublishDefaults {
  const workerUrl = opts.env.ACTUALLY_WORKER_URL || fromEnvLocal(opts.envLocalText, 'VITE_WORKER_URL')
  const workerSecret =
    opts.env.ACTUALLY_WORKER_SECRET || fromEnvLocal(opts.envLocalText, 'VITE_WORKER_SECRET')
  const builderCode = opts.env.ACTUALLY_BUILDER_CODE ?? ''

  if (opts.isPublish && (!workerUrl || !workerSecret)) {
    throw new Error(
      'Refusing to publish with empty baked worker defaults: set ACTUALLY_WORKER_URL and ' +
        'ACTUALLY_WORKER_SECRET (or make sure extension/.env.local is present and filled). ' +
        'A package published without them ships a dead check_news/get_market for every npx user.',
    )
  }

  return { builderCode, workerUrl, workerSecret }
}
