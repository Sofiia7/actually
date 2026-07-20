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

function today(): string {
  return new Date().toISOString().slice(0, 10)
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
      if (typeof parsed.day !== 'string' || typeof parsed.daySpentUsd !== 'number') {
        throw new Error('malformed_state')
      }
      this.day = parsed.day
      this.daySpentUsd = parsed.daySpentUsd
    } catch {
      // A state file we can't trust must not silently reopen the full daily
      // budget — that's the dangerous direction for a real-money backstop
      // (an operator who'd already spent most of today's cap would get a
      // fresh $0 and could blow through the limit on the next call). Fail
      // closed instead: treat today as already fully spent. Self-heals at
      // the next UTC day rollover; an operator who wants it sooner can
      // delete the state file.
      this.day = today()
      this.daySpentUsd = this.config.dailyLimitUsd
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
    const t = today()
    if (t !== this.day) {
      this.day = t
      this.daySpentUsd = 0
    }
  }

  /**
   * Atomically checks the per-order and daily caps AND commits the spend in
   * one synchronous call — no `await` between the check and the write, so no
   * other tool call can interleave (JS's single-threaded event loop makes
   * this call itself atomic). The previous check()-then-record() split left
   * an await-sized window (order signing + network submit) between them
   * where several concurrent place_order/sell_order calls could all pass
   * check() before any of them called record(), letting combined spend blow
   * through dailyLimitUsd. Call release() if the order ultimately doesn't go
   * through, to give the reserved budget back.
   */
  reserve(sizeUsd: number): SpendCheck {
    this.rollDayIfNeeded()
    if (sizeUsd > this.config.maxOrderUsd) {
      return { ok: false, error: `order_exceeds_max_usd:${this.config.maxOrderUsd}` }
    }
    if (this.daySpentUsd + sizeUsd > this.config.dailyLimitUsd) {
      return { ok: false, error: `daily_limit_exceeded:${this.config.dailyLimitUsd}` }
    }
    this.daySpentUsd += sizeUsd
    this.saveState()
    return { ok: true }
  }

  /** Give back budget reserved by reserve() for an order that was rejected, failed, or threw. */
  release(sizeUsd: number): void {
    this.rollDayIfNeeded()
    this.daySpentUsd = Math.max(0, this.daySpentUsd - sizeUsd)
    this.saveState()
  }
}
