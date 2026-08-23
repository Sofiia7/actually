/**
 * Resolves the publish-time baked defaults for tsup.config.ts.
 *
 * Why this exists: `prepublishOnly` re-runs `npm run build` at `npm publish`
 * time. Before this helper, a publish from a shell without ACTUALLY_WORKER_URL
 * / ACTUALLY_WORKER_SECRET silently baked empty strings - shipping a package
 * whose zero-setup tools (check_news / get_market) throw "not configured" for
 * every npx user. Now:
 *
 *  - worker url/secret AND builder code: explicit env var →
 *    extension/.env.local (the maintainer's dev machine always has it; these
 *    are the SAME values the extension bakes, public by design) → empty.
 *    Builder code used to be env-var-only, deliberately never inherited from
 *    .env.local, while whether to ship it in a public package was still an
 *    open Polymarket ToS question (R1). That question is resolved - publish
 *    always bakes it in - so withholding it from the .env.local fallback now
 *    only recreates the exact bug this file exists to prevent: a publish
 *    that silently ships without it (place_order/sell_order then fail
 *    `builder_code_not_configured` for every user with a configured wallet).
 *  - a PUBLISH build (npm_lifecycle_event === 'prepublishOnly') with an empty
 *    worker url/secret/builder code fails loudly instead of shipping a dead
 *    or trading-broken package. Ordinary dev/CI builds still tolerate
 *    empties (CI has no .env.local and the tests mock the store).
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
  const builderCode =
    opts.env.ACTUALLY_BUILDER_CODE || fromEnvLocal(opts.envLocalText, 'VITE_BUILDER_CODE')

  if (opts.isPublish && (!workerUrl || !workerSecret)) {
    throw new Error(
      'Refusing to publish with empty baked worker defaults: set ACTUALLY_WORKER_URL and ' +
        'ACTUALLY_WORKER_SECRET (or make sure extension/.env.local is present and filled). ' +
        'A package published without them ships a dead check_news/get_market for every npx user.',
    )
  }
  if (opts.isPublish && !builderCode) {
    throw new Error(
      'Refusing to publish with an empty baked builder code: set ACTUALLY_BUILDER_CODE ' +
        '(or make sure extension/.env.local is present and filled). A package published without ' +
        "it ships place_order/sell_order that fail builder_code_not_configured for every user " +
        'who configures a wallet.',
    )
  }

  return { builderCode, workerUrl, workerSecret }
}
