/**
 * Server config, read once at startup. `BUILDER_CODE` is baked at publish
 * time by tsup's `define` (see tsup.config.ts, wired in a later task) — until
 * then it falls back to the empty string, which disables order-signing
 * tools entirely (see place_order / prepare_order, implemented later).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

declare const __BUILDER_CODE__: string | undefined
declare const __DEFAULT_WORKER_URL__: string | undefined
declare const __DEFAULT_WORKER_SECRET__: string | undefined
declare const __PKG_VERSION__: string | undefined

export const BUILDER_CODE: string =
  typeof __BUILDER_CODE__ !== 'undefined' ? __BUILDER_CODE__ : ''

/**
 * Server version reported to MCP clients. Baked in by tsup's `define` the
 * same way BUILDER_CODE is (see tsup.config.ts) — reads package.json
 * directly at publish time, so it can never drift from the published
 * version again (0.1.0 and 0.1.1 both shipped with a hand-edited literal
 * in index.ts that fell out of sync with package.json). In dev/test, where
 * the define isn't baked in, falls back to reading package.json off disk.
 */
export const PKG_VERSION: string =
  typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : readPkgVersionFallback()

function readPkgVersionFallback(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    return pkg.version
  } catch {
    return '0.0.0-dev'
  }
}

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
 * redeem_position submits a real on-chain transaction through the Polymarket
 * relayer — unlike place_order/sell_order, a bug here has no CLOB-rejection
 * safety net; it can mean a genuinely lost or stuck payout, and (per the
 * project's own launch checklist) this path has never been exercised against
 * a real resolved mainnet position. Opt-in only, separate from PRIVATE_KEY,
 * so an operator has to make the same call twice before an agent can reach it.
 *
 * Status as of 2026-08-21 — three separate layers have been fixed and
 * verified against live services, and the last mile is still unproven:
 *   builder auth on POST /submit   verified (relayer answers on the merits)
 *   neg-risk contract selection     verified (NegRiskAdapter, flag arrives)
 *   losing-position guard           added (relayer's own precheck agreed)
 *   a redeem that actually collects  NOT YET OBSERVED — relayer-v2
 *                                    /transactions is still empty
 * Treat this as in testing until a resolved position with currentValue > 0
 * has been redeemed end to end.
 */
export const REDEEM_ENABLED: boolean = process.env.ACTUALLY_ENABLE_REDEEM === 'true'

/**
 * Let check_news fall back to Polymarket's own market search when nothing in
 * the cached set clears the floor.
 *
 * The cache is a fixed shelf (~2000 markets) and Polymarket carries several
 * times that, so the long tail is unreachable without this — a real, open,
 * actively-traded market can look to an agent exactly like a market that does
 * not exist.
 *
 * Off by default for the same reason as in the extension: the query is built
 * from the caller's text and leaves this machine. That the text has usually
 * already passed through a model does not make the extra egress the
 * operator's default; it makes it their decision.
 */
export const SEARCH_FALLBACK_ENABLED: boolean = process.env.ACTUALLY_SEARCH_FALLBACK === 'true'

/**
 * Builder API credentials, from polymarket.com -> Settings -> Builders ->
 * "+ Create New". Polymarket's relayer requires them on POST /submit (HMAC
 * headers named POLY_BUILDER_*); without them redeem_position gets a bare
 * 401 "invalid authorization" no matter how correct the transaction is.
 *
 * Note this is a DIFFERENT credential from the builder CODE baked into the
 * package for order attribution — that one is public by design, these are
 * not. Unlike the extension (which cannot hold a secret and asks its Worker
 * to sign instead), this server already runs on the operator's own machine
 * with their private key, so local credentials are the right shape here.
 */
export const BUILDER_API_KEY: string | undefined = process.env.POLYMARKET_BUILDER_API_KEY
export const BUILDER_API_SECRET: string | undefined = process.env.POLYMARKET_BUILDER_API_SECRET
export const BUILDER_API_PASSPHRASE: string | undefined = process.env.POLYMARKET_BUILDER_API_PASSPHRASE

/**
 * Alternative: a RELAYER API KEY — the scheme Polymarket's settings UI
 * currently hands out (Settings → API Keys → Relayer API Keys → "Create").
 * Two static values, no passphrase, scoped to the creating account. For this
 * server that scoping is exactly right: the operator IS the account whose
 * positions get redeemed.
 */
export const RELAYER_API_KEY: string | undefined = process.env.POLYMARKET_RELAYER_API_KEY
export const RELAYER_API_KEY_ADDRESS: string | undefined = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS

/** Which relayer-auth scheme is configured. Builder HMAC wins when both are. */
export function relayerAuthMode(): 'builder' | 'relayer' | null {
  if (BUILDER_API_KEY && BUILDER_API_SECRET && BUILDER_API_PASSPHRASE) return 'builder'
  if (RELAYER_API_KEY && RELAYER_API_KEY_ADDRESS) return 'relayer'
  return null
}

/** True when redeeming can authenticate at all. */
export function builderCredsConfigured(): boolean {
  return relayerAuthMode() !== null
}

/**
 * Real-money backstops for place_order/sell_order — a prompt-injected or
 * buggy calling agent must not be able to drain the operator's wallet in one
 * call or over one day. Defaults are deliberately conservative; an operator
 * running unattended must opt into a higher ceiling explicitly.
 */
export const MAX_ORDER_USD: number = parseEnvUsd('ACTUALLY_MAX_ORDER_USD', process.env.ACTUALLY_MAX_ORDER_USD, 100)
export const DAILY_LIMIT_USD: number = parseEnvUsd('ACTUALLY_DAILY_LIMIT_USD', process.env.ACTUALLY_DAILY_LIMIT_USD, 500)

/**
 * Where SpendGuard persists the day + spent-so-far so the daily cap survives
 * a process restart (the norm for MCP clients, which spawn this server as a
 * subprocess per session). Defaults to a per-user file outside the repo;
 * override for a custom deployment layout or to isolate test runs.
 */
export const SPEND_GUARD_STATE_PATH: string =
  process.env.ACTUALLY_SPEND_STATE_PATH || join(homedir(), '.actually-mcp-server', 'spend-guard.json')

/**
 * An unset env var uses `fallback` — that's the normal, safe path. But once
 * an operator has explicitly SET one of these real-money limits, a typo or
 * malformed value (`"5O"`, `"50 USD"`, `"0"`, `"-5"`) must not silently
 * relax it back to the (looser) built-in default — that's the dangerous
 * direction for a control whose entire purpose is capping worst-case loss.
 * Fail loudly at startup instead, naming the bad variable, the same way
 * `requireWorkerConfig` already does for the Worker URL/secret.
 */
function parseEnvUsd(varName: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${varName} is set to "${raw}", which is not a positive number. ` +
        `Fix or unset ${varName} (unset falls back to the $${fallback} default).`,
    )
  }
  return n
}

export function requireWorkerConfig(): { workerUrl: string; workerSecret: string } {
  if (!WORKER_URL || !WORKER_SECRET) {
    throw new Error(
      'actually-mcp-server is not configured: set ACTUALLY_WORKER_URL and ACTUALLY_WORKER_SECRET.',
    )
  }
  return { workerUrl: WORKER_URL, workerSecret: WORKER_SECRET }
}
