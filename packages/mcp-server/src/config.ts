/**
 * Server config, read once at startup. `BUILDER_CODE` is baked at publish
 * time by tsup's `define` (see tsup.config.ts, wired in a later task) — until
 * then it falls back to the empty string, which disables order-signing
 * tools entirely (see place_order / prepare_order, implemented later).
 */
declare const __BUILDER_CODE__: string | undefined

export const BUILDER_CODE: string =
  typeof __BUILDER_CODE__ !== 'undefined' ? __BUILDER_CODE__ : ''

export const WORKER_URL: string = process.env.ACTUALLY_WORKER_URL ?? ''
export const WORKER_SECRET: string = process.env.ACTUALLY_WORKER_SECRET ?? ''
export const PRIVATE_KEY: string | undefined = process.env.POLYMARKET_PRIVATE_KEY

export function requireWorkerConfig(): { workerUrl: string; workerSecret: string } {
  if (!WORKER_URL || !WORKER_SECRET) {
    throw new Error(
      'actually-mcp-server is not configured: set ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET.',
    )
  }
  return { workerUrl: WORKER_URL, workerSecret: WORKER_SECRET }
}
