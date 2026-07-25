import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

// How long a lock file may sit unreleased before a NEW acquirer assumes its
// owner crashed mid-reserve() and busts it — an `openSync(path, 'wx')` lock
// has no OS-level "owner died" notification, unlike flock(2), so a orphaned
// lock would otherwise wedge every future reserve()/release() call forever.
const LOCK_STALE_MS = 5_000
// How long a NEW acquirer retries before giving up and proceeding WITHOUT
// the lock. This is a best-effort race reduction (see syncFromDisk's own
// doc comment), not a hard guarantee — a real trading call must never hang
// indefinitely over local file contention.
const LOCK_MAX_WAIT_MS = 2_000
const LOCK_RETRY_MS = 20

/**
 * Synchronous cross-process mutual exclusion via exclusive file creation
 * (`wx` — fails if the file already exists), the one atomic primitive
 * `node:fs` offers without a native addon or extra dependency. Busy-waits
 * with `Atomics.wait` (safe on Node's main thread, unlike a browser) instead
 * of an async retry loop, because reserve()/release() must stay fully
 * synchronous — see reserve()'s own doc comment for why that matters.
 */
function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false // unexpected fs error — don't block a real trade on it
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath) // orphaned lock from a crashed process — bust it and retry immediately
          continue
        }
      } catch {
        continue // lock vanished between our failed create and this stat (owner released it) — retry immediately
      }
      if (Date.now() >= deadline) return false
      Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS)
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // Already gone (e.g. busted as stale by another process) — fine.
  }
}

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

export type SpendCheck = { ok: true; reservedDay: string } | { ok: false; error: string }

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
      if (
        typeof parsed.day !== 'string' ||
        typeof parsed.daySpentUsd !== 'number' ||
        !Number.isFinite(parsed.daySpentUsd) ||
        parsed.daySpentUsd < 0
      ) {
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

  /**
   * Best-effort merge with whatever's currently on disk, called at the top
   * of every reserve() (in addition to the one-time load in the
   * constructor). Every MCP client (Claude Desktop, Claude Code, Cursor...)
   * spawns its own server subprocess, each starting from whatever the file
   * said at ITS launch time — without re-reading here, N concurrent
   * processes each track spend independently and combined real spend can
   * reach N × dailyLimitUsd. Re-reading before every reserve() closes most
   * of that gap (a residual write-write race remains: two processes can
   * still both read-then-write between each other's save, this is a
   * best-effort reduction, not a full distributed lock).
   */
  private syncFromDisk(): void {
    const path = this.config.statePath
    if (!path || !existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedState>
      if (
        typeof parsed.day !== 'string' ||
        typeof parsed.daySpentUsd !== 'number' ||
        !Number.isFinite(parsed.daySpentUsd) ||
        parsed.daySpentUsd < 0
      ) {
        return // don't let a corrupt on-disk read stomp good in-memory state
      }
      if (parsed.day === this.day) {
        this.daySpentUsd = Math.max(this.daySpentUsd, parsed.daySpentUsd)
      } else if (parsed.day > this.day) {
        // A peer process already rolled over to a newer UTC day than we've
        // observed — adopt its view rather than keep comparing stale totals
        // from yesterday against today's.
        this.day = parsed.day
        this.daySpentUsd = parsed.daySpentUsd
      }
    } catch {
      // Best-effort merge only — loadState()'s fail-closed handling already
      // covers the startup case; a transient read/parse hiccup here just
      // means this call proceeds on the in-memory view.
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
   * Runs `fn` holding a cross-process file lock derived from `statePath`
   * (`<statePath>.lock`) — see acquireLock's doc comment. Without a
   * configured statePath there's nothing on disk for another process to
   * race against, so this just runs `fn` directly. If the lock can't be
   * acquired within LOCK_MAX_WAIT_MS, `fn` still runs unlocked rather than
   * blocking a real trade indefinitely — this narrows the cross-process
   * race window, it does not eliminate it (see syncFromDisk's doc comment).
   */
  private withLock<T>(fn: () => T): T {
    const path = this.config.statePath
    if (!path) return fn()
    const lockPath = `${path}.lock`
    const locked = acquireLock(lockPath)
    try {
      return fn()
    } finally {
      if (locked) releaseLock(lockPath)
    }
  }

  /**
   * Checks the per-order and daily caps AND commits the spend in one call —
   * no `await` anywhere in `fn`, so no other tool call in THIS process can
   * interleave (JS's single-threaded event loop makes that part atomic on
   * its own). The previous check()-then-record() split left an await-sized
   * window (order signing + network submit) between them where several
   * concurrent place_order/sell_order calls could all pass check() before
   * any of them called record(), letting combined spend blow through
   * dailyLimitUsd. Call release() if the order ultimately doesn't go
   * through, to give the reserved budget back. Wrapped in withLock() so a
   * SEPARATE process doing the same read-modify-write can't interleave with
   * this one either — see withLock's and acquireLock's doc comments.
   */
  reserve(sizeUsd: number): SpendCheck {
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      // A non-finite or non-positive size (NaN, Infinity, 0, negative) must
      // never silently pass the checks below — NaN comparisons are always
      // false, which would poison daySpentUsd and disable the daily cap for
      // the rest of the UTC day.
      return { ok: false, error: 'invalid_size' }
    }
    return this.withLock(() => {
      this.rollDayIfNeeded()
      this.syncFromDisk()
      this.rollDayIfNeeded() // a peer process's on-disk day may be newer than ours
      if (sizeUsd > this.config.maxOrderUsd) {
        return { ok: false, error: `order_exceeds_max_usd:${this.config.maxOrderUsd}` }
      }
      if (this.daySpentUsd + sizeUsd > this.config.dailyLimitUsd) {
        return { ok: false, error: `daily_limit_exceeded:${this.config.dailyLimitUsd}` }
      }
      this.daySpentUsd += sizeUsd
      this.saveState()
      return { ok: true, reservedDay: this.day }
    })
  }

  /**
   * Give back budget reserved by reserve() for an order that was rejected,
   * failed, or threw. `reservedDay` should be the `reservedDay` a matching
   * reserve() call returned — if the UTC day has since rolled over, this is
   * a no-op instead of refunding into the NEW day's budget (rollDayIfNeeded
   * already zeroed the counter at rollover, so crediting it again here would
   * let that day's real spend exceed dailyLimitUsd by the refunded amount).
   * Omit `reservedDay` to preserve the old same-day-assumed behavior for
   * callers/tests that don't track it. Also syncs from disk and takes the
   * same cross-process lock as reserve() — without both, this could refund
   * against a stale in-memory total or race a concurrent process's own
   * reserve()/release() write.
   */
  release(sizeUsd: number, reservedDay?: string): void {
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return
    this.withLock(() => {
      this.rollDayIfNeeded()
      this.syncFromDisk()
      this.rollDayIfNeeded()
      if (reservedDay !== undefined && reservedDay !== this.day) return
      this.daySpentUsd = Math.max(0, this.daySpentUsd - sizeUsd)
      this.saveState()
    })
  }
}
