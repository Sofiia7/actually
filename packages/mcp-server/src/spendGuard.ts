export interface SpendGuardConfig {
  /** Reject any single order above this notional (USD). */
  maxOrderUsd: number
  /** Reject an order that would push the rolling UTC-day total above this. */
  dailyLimitUsd: number
}

export type SpendCheck = { ok: true } | { ok: false; error: string }

/**
 * In-memory backstop against a prompt-injected or buggy agent draining the
 * operator's wallet through place_order. Process-lifetime only (resets on
 * restart) — this is a blast-radius limiter, not an accounting system.
 */
export class SpendGuard {
  private daySpentUsd = 0
  private day = ''

  constructor(private readonly config: SpendGuardConfig) {}

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
  }
}
