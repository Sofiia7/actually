import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SpendGuardConfig {
  /** Reject any single order above this notional (USD). */
  maxOrderUsd: number
  /** Reject an order that would push the rolling UTC-day total above this. */
  dailyLimitUsd: number
  /**
   * Optional path to a JSON file that persists the day + spent-so-far across
   * process restarts. Most MCP clients (Claude Desktop/Code) spawn this
   * server as a fresh subprocess per session and kill it on close, so without
   * this the "daily" limit resets far more often than daily in practice. When
   * omitted, state is in-memory only for this process's lifetime.
   */
  statePath?: string
}

export type SpendCheck = { ok: true } | { ok: false; error: string }

interface PersistedState {
  day: string
  daySpentUsd: number
}

/**
 * Backstop against a prompt-injected or buggy agent draining the operator's
 * wallet through place_order. A blast-radius limiter, not a full accounting
 * system — see `statePath` above for why persistence still matters.
 */
export class SpendGuard {
  private daySpentUsd = 0
  private day = ''

  constructor(private readonly config: SpendGuardConfig) {
    if (config.statePath) this.loadState()
  }

  private loadState(): void {
    const path = this.config.statePath
    if (!path || !existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedState>
      if (typeof parsed.day === 'string' && typeof parsed.daySpentUsd === 'number') {
        this.day = parsed.day
        this.daySpentUsd = parsed.daySpentUsd
      }
    } catch {
      // Missing/corrupt state file is not fatal — start at $0 for today
      // rather than block the server on a bad read.
    }
  }

  private saveState(): void {
    const path = this.config.statePath
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ day: this.day, daySpentUsd: this.daySpentUsd } satisfies PersistedState))
    } catch {
      // Best-effort — a filesystem error here must not crash a trading call.
      // Worst case the cap reverts to process-lifetime-only for this run.
    }
  }

  private rollDayIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.daySpentUsd = 0
    }
  }

  /** Call before submitting an order. Does not mutate state — call record() after a confirmed submit. */
  check(sizeUsd: number): SpendCheck {
    this.rollDayIfNeeded()
    if (sizeUsd > this.config.maxOrderUsd) {
      return { ok: false, error: `order_exceeds_max_usd:${this.config.maxOrderUsd}` }
    }
    if (this.daySpentUsd + sizeUsd > this.config.dailyLimitUsd) {
      return { ok: false, error: `daily_limit_exceeded:${this.config.dailyLimitUsd}` }
    }
    return { ok: true }
  }

  /** Call only after a successful submit — a rejected/failed order must not count against the daily total. */
  record(sizeUsd: number): void {
    this.rollDayIfNeeded()
    this.daySpentUsd += sizeUsd
    this.saveState()
  }
}
