/**
 * Make the offscreen document's console readable, and keep a copy.
 *
 * WalletConnect logs through its own logger, which writes plain objects to
 * `console.error`. Chrome's extension error list renders those as the string
 * "[object Object]" - three of them in a row was the entire report of a failed
 * wallet connect, with the payload that would have explained it discarded by
 * the console itself. Our own error paths were fixed by describeError(); this
 * covers the ones a dependency emits, which no amount of care in our code can
 * reach.
 *
 * Two things happen here:
 *   - object arguments are expanded before they reach the console, so the
 *     error list shows content rather than a type name;
 *   - the same line is appended to the connect log, so it survives the
 *     document being torn down and can be copied out of Settings by someone
 *     who cannot open devtools on an offscreen page (which is most people).
 */
import { describeError } from '../shared/describeError'
import { logConnect } from '../background/connectLog'

/** Ceiling per line: this feeds a 60-entry ring buffer, not a log file. */
const MAX_LINE = 600

function formatOne(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.message || arg.name}`
  if (arg === null || typeof arg !== 'object') return String(arg)
  const described = describeError(arg)
  // describeError returns the bare type name only when JSON refused the value.
  if (described !== '[object Object]') return described
  try {
    return JSON.stringify(arg, Object.getOwnPropertyNames(arg))
  } catch {
    return '[unserializable object]'
  }
}

export function formatConsoleArgs(args: unknown[]): string {
  const line = args.map(formatOne).join(' ')
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line
}

let installed = false

/**
 * Wrap console.error/console.warn. Idempotent, and it always calls through to
 * the original console: this is a lens, not a filter.
 */
export function installConsoleCapture(): void {
  if (installed) return
  installed = true
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      let line: string
      try {
        line = formatConsoleArgs(args)
      } catch {
        // Never let the diagnostic layer break the thing it is diagnosing.
        original(...args)
        return
      }
      original(line)
      void logConnect(`console_${level}`, line)
    }
  }
}
