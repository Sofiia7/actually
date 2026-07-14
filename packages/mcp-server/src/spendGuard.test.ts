import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpendGuard } from './spendGuard'

afterEach(() => {
  vi.useRealTimers()
})

describe('SpendGuard', () => {
  it('allows an order under both the per-order and daily caps', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    expect(guard.check(50)).toEqual({ ok: true })
  })

  it('rejects a single order exceeding maxOrderUsd', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    const result = guard.check(101)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('order_exceeds_max_usd')
  })

  it('accumulates recorded spend and rejects once the daily limit would be exceeded', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    expect(guard.check(100)).toEqual({ ok: true })
    guard.record(100)
    const second = guard.check(60)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toContain('daily_limit_exceeded')
  })

  it('does not count a checked-but-not-recorded order (e.g. a failed submit) against the daily total', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    guard.check(100) // checked, never recorded (order failed downstream)
    expect(guard.check(100)).toEqual({ ok: true })
  })

  it('resets the daily counter when the UTC day rolls over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T23:59:00Z'))
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    guard.record(100)
    expect(guard.check(1).ok).toBe(false)

    vi.setSystemTime(new Date('2026-07-05T00:01:00Z'))
    expect(guard.check(100)).toEqual({ ok: true })
  })

  it('persists recorded spend to statePath and honors it across a fresh instance (process restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-04T12:00:00Z'))

      const first = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      first.record(100)

      // A brand-new instance (as if the MCP client just respawned the
      // process) must see the same day's spend from disk, not start at $0.
      const second = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const result = second.check(60)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('daily_limit_exceeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
