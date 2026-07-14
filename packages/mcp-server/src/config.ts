/**
 * Server config, read once at startup. `BUILDER_CODE` is baked at publish
 * time by tsup's `define` (see tsup.config.ts, wired in a later task) — until
 * then it falls back to the empty string, which disables order-signing
 * tools entirely (see place_order / prepare_order, implemented later).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

declare const __BUILDER_CODE__: string | undefined
declare const __DEFAULT_WORKER_URL__: string | undefined
declare const __DEFAULT_WORKER_SECRET__: string | undefined

export const BUILDER_CODE: string =
  typeof __BUILDER_CODE__ !== 'undefined' ? __BUILDER_CODE__ : ''

/**
 * Default backing Worker, baked at publish time the same way BUILDER_CODE is
 * (see tsup.config.ts). Lets `npx actually-mcp-server` work for check_news/
 * get_market with zero setup, mirroring the browser extension's baked
 * VITE_WORKER_URL/VITE_WORKER_SECRET (see extension/src/shared/constants.ts).
 * This shared secret is public-by-design (see SECURITY.md / worker-secret
 * threat model) — it provides no confidentiality, only an anti-accidental-
 * load defense; the real backstop is the Worker's per-IP rate limit and
 * OpenAI daily cap. Operators running their own Worker override both via
 * ACTUALLY_WORKER_URL / ACTUALLY_WORKER_SECRET.
 */
const DEFAULT_WORKER_URL: string =
  typeof __DEFAULT_WORKER_URL__ !== 'undefined' ? __DEFAULT_WORKER_URL__ : ''
const DEFAULT_WORKER_SECRET: string =
  typeof __DEFAULT_WORKER_SECRET__ !== 'undefined' ? __DEFAULT_WORKER_SECRET__ : ''

export const WORKER_URL: string = process.env.ACTUALLY_WORKER_URL || DEFAULT_WORKER_URL
export const WORKER_SECRET: string = process.env.ACTUALLY_WORKER_SECRET || DEFAULT_WORKER_SECRET
export const PRIVATE_KEY: string | undefined = process.env.POLYMARKET_PRIVATE_KEY

/**
 * Real-money backstops for place_order/sell_order — a prompt-injected or
 * buggy calling agent must not be able to drain the operator's wallet in one
 * call or over one day. Defaults are deliberately conservative; an operator
 * running unattended must opt into a higher ceiling explicitly.
 */
export const MAX_ORDER_USD: number = parseEnvUsd(process.env.ACTUALLY_MAX_ORDER_USD, 100)
export const DAILY_LIMIT_USD: number = parseEnvUsd(process.env.ACTUALLY_DAILY_LIMIT_USD, 500)

/**
 * Where SpendGuard persists the day + spent-so-far so the daily cap survives
 * a process restart (the norm for MCP clients, which spawn this server as a
 * subprocess per session). Defaults to a per-user file outside the repo;
 * override for a custom deployment layout or to isolate test runs.
 */
export const SPEND_GUARD_STATE_PATH: string =
  process.env.ACTUALLY_SPEND_STATE_PATH || join(homedir(), '.actually-mcp-server', 'spend-guard.json')

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
