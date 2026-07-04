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

/**
 * Real-money backstops for place_order/sell_order — a prompt-injected or
 * buggy calling agent must not be able to drain the operator's wallet in one
 * call or over one day. Defaults are deliberately conservative; an operator
 * running unattended must opt into a higher ceiling explicitly.
 */
export const MAX_ORDER_USD: number = parseEnvUsd(process.env.ACTUALLY_MAX_ORDER_USD, 100)
export const DAILY_LIMIT_USD: number = parseEnvUsd(process.env.ACTUALLY_DAILY_LIMIT_USD, 500)

function parseEnvUsd(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function requireWorkerConfig(): { workerUrl: string; workerSecret: string } {
  if (!WORKER_URL || !WORKER_SECRET) {
    throw new Error(
      'actually-mcp-server is not configured: set ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET.',
    )
  }
  return { workerUrl: WORKER_URL, workerSecret: WORKER_SECRET }
}
