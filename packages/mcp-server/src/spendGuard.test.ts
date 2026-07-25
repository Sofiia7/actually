import { describe, expect, it, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpendGuard } from './spendGuard'

afterEach(() => {
  vi.useRealTimers()
})

describe('SpendGuard', () => {
  it('allows an order under both the per-order and daily caps', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    const result = guard.reserve(50)
    expect(result.ok).toBe(true)
    expect(result.ok && result.reservedDay).toEqual(expect.any(String))
  })

  it('rejects a single order exceeding maxOrderUsd', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    const result = guard.reserve(101)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('order_exceeds_max_usd')
  })

  it('accumulates reserved spend and rejects once the daily limit would be exceeded', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    expect(guard.reserve(100).ok).toBe(true)
    const second = guard.reserve(60)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toContain('daily_limit_exceeded')
  })

  it('does not count a released order (e.g. a failed submit) against the daily total', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150 })
    const first = guard.reserve(100)
    guard.release(100, first.ok ? first.reservedDay : undefined) // order failed downstream, budget given back
    expect(guard.reserve(100).ok).toBe(true)
  })

  it('resets the daily counter when the UTC day rolls over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T23:59:00Z'))
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    guard.reserve(100)
    expect(guard.reserve(1).ok).toBe(false)

    vi.setSystemTime(new Date('2026-07-05T00:01:00Z'))
    expect(guard.reserve(100).ok).toBe(true)
  })

  it('rejects a non-finite or non-positive sizeUsd instead of letting it poison the daily total', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 500 })
    for (const bad of [NaN, Infinity, -Infinity, 0, -5]) {
      const result = guard.reserve(bad)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toBe('invalid_size')
    }
    // The daily total must be untouched — a subsequent real reserve at the
    // per-order cap still succeeds (would fail if a NaN had poisoned
    // daySpentUsd toward a value where dailyLimitUsd comparisons broke).
    expect(guard.reserve(100).ok).toBe(true)
  })

  it('release() ignores a non-finite or non-positive sizeUsd rather than corrupting the total', () => {
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    guard.reserve(100)
    guard.release(NaN)
    guard.release(-5)
    // Still fully reserved — the bad releases must not have refunded anything.
    expect(guard.reserve(1).ok).toBe(false)
  })

  it('a release() after UTC midnight does not refund into the new day\'s budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T23:59:58Z'))
    const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 100 })
    const reserved = guard.reserve(100) // fully spends day D's budget
    expect(reserved.ok).toBe(true)

    vi.setSystemTime(new Date('2026-07-05T00:00:02Z'))
    // A peer reserve() on the new day spends its own fresh budget.
    expect(guard.reserve(100).ok).toBe(true)

    // The original order (reserved against day D) finally fails and releases
    // — must NOT refund into day D+1's already-fully-spent budget.
    guard.release(100, reserved.ok ? reserved.reservedDay : undefined)
    expect(guard.reserve(1).ok).toBe(false)
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
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toContain('daily_limit_exceeded')
  })

  it('re-reads statePath on every reserve() so a peer process\'s spend is not lost (reduces, does not eliminate, cross-process multiplication)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      const a = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const b = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      expect(a.reserve(80).ok).toBe(true) // process A spends $80, writes to disk
      expect(b.reserve(80).ok).toBe(false) // process B re-reads disk before checking — sees A's $80, $80+$80 > $150
      expect(b.reserve(60).ok).toBe(true) // $80 + $60 = $140, still under $150
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('busts a stale lock file left by a crashed process and proceeds without waiting the full timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    const lockPath = `${statePath}.lock`
    try {
      writeFileSync(lockPath, '99999') // a pid that no longer exists, from a crashed process
      const oldTime = new Date(Date.now() - 60_000) // well past the 5s staleness threshold
      utimesSync(lockPath, oldTime, oldTime)
      const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const start = Date.now()
      const result = guard.reserve(50)
      expect(result.ok).toBe(true)
      expect(Date.now() - start).toBeLessThan(1000) // busted immediately, did not wait out LOCK_MAX_WAIT_MS
      expect(existsSync(lockPath)).toBe(false) // released after use
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('proceeds without the lock (best-effort) rather than hanging a real trade forever if a live lock is held past the max wait', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    const lockPath = `${statePath}.lock`
    try {
      writeFileSync(lockPath, String(process.pid)) // a "live" holder (fresh mtime, never released)
      const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
      const result = guard.reserve(50) // must still complete, not hang forever
      expect(result.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

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
      expect(guard.reserve(100).ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a persisted daySpentUsd that is negative or non-finite, instead of granting extra/unlimited budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-test-'))
    const statePath = join(dir, 'spend-guard.json')
    try {
      for (const bad of [-5, Infinity, -Infinity]) {
        writeFileSync(statePath, JSON.stringify({ day: today(), daySpentUsd: bad }))
        const guard = new SpendGuard({ maxOrderUsd: 100, dailyLimitUsd: 150, statePath })
        const result = guard.reserve(1)
        expect(result.ok).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}
