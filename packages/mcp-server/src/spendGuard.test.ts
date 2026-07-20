import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpendGuard } from './spendGuard'

afterEach(() => {
  vi.useRealTimers()
})

describe('SpendGuard', () => {
  it('allows an order under both the per-order and daily caps', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    expect(guard.reserve(50)).toEqual({ ok: true })
  })

  it('rejects a single order exceeding maxOrderUsd', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    const result = guard.reserve(101)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('order_exceeds_max_usd')
  })

  it('accumulates reserved spend and rejects once the daily limit would be exceeded', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    expect(guard.reserve(100)).toEqual({ ok: true })
    const second = guard.reserve(60)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toContain('daily_limit_exceeded')
  })

  it('does not count a released order (e.g. a failed submit) against the daily total', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    guard.reserve(100)
    guard.release(100) // order failed downstream, budget given back
    expect(guard.reserve(100)).toEqual({ ok: true })
  })

  it('resets the daily counter when the UTC day rolls over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T23:59:00Z'))
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    guard.reserve(100)
    expect(guard.reserve(1).ok).toBe(false)

    vi.setSystemTime(new Date('2026-07-05T00:01:00Z'))
    expect(guard.reserve(100)).toEqual({ ok: true })
  })

  it('persists reserved spend to statePath and honors it across a fresh instance (process restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-04T12:00:00Z'))

      const first = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      first.reserve(100)

      // A brand-new instance (as if the MCP client just respawned the
      // process) must see the same day's spend from disk, not start at $0.
      const second = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const result = second.reserve(60)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('daily_limit_exceeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes the check/record TOCTOU race: two back-to-back reserves cannot both pass a limit only one fits under', () => {
    // Simulates two "concurrent" place_order calls racing to spend against
    // the same $100 daily cap with $60 orders each. The old check()/record()
    // split let both check() calls pass before either recorded (the gap was
    // the awaited sign+submit round-trip); reserve() commits synchronously,
    // so the second call sees the first's committed spend immediately.
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    const first = guard.reserve(60)
    const second = guard.reserve(60)
    expect(first).toEqual({ ok: true })
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toContain('daily_limit_exceeded')
  })

  it('fails closed (treats today as already fully spent) when the state file is corrupt, instead of silently reopening the full daily budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      writeFileSync(statePath, '{not valid json')
      const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const result = guard.reserve(1)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('daily_limit_exceeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a corrupted state file self-heals on the next UTC day rollover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      writeFileSync(statePath, '{not valid json')
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-04T12:00:00Z'))
      const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      expect(guard.reserve(1).ok).toBe(false)

      vi.setSystemTime(new Date('2026-07-05T00:01:00Z'))
      expect(guard.reserve(100)).toEqual({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
