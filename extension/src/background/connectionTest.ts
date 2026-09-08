import { describeError } from '../shared/describeError'
import type { TestKeysResult } from '../shared/types'
import { getSettings } from './settings'

/**
 * `/health` is deliberately unauthenticated (an infra liveness probe), so it
 * says nothing about whether workerSecret itself is valid. Before this, a
 * wrong secret with a local embedding provider (the openai check below never
 * runs) passed every check here and only surfaced later as an unexplained
 * 401 on the first real request (2026-09-08 audit F23). `/geo` is cheap (no
 * upstream fetch) but still runs through the Worker's real auth check, so a
 * bad secret fails it exactly the way it fails a real request. `/ready`
 * reports market-cache freshness separately, since that's a config/data
 * problem, not an auth problem.
 */
export async function testConnection(): Promise<TestKeysResult> {
  const settings = await getSettings()
  const out: TestKeysResult = { worker: { ok: false } }

  if (!settings.workerUrl) {
    out.worker = { ok: false, error: 'no_url' }
    return out
  }

  try {
    const res = await fetch(`${settings.workerUrl}/health`)
    out.worker = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
  } catch (err) {
    out.worker = { ok: false, error: describeError(err) }
  }

  if (out.worker.ok) {
    try {
      const res = await fetch(`${settings.workerUrl}/geo`, {
        headers: { 'X-Actually-Auth': settings.workerSecret },
      })
      out.auth = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
    } catch (err) {
      out.auth = { ok: false, error: describeError(err) }
    }

    try {
      const res = await fetch(`${settings.workerUrl}/ready`)
      // /ready answers 503 (not res.ok) precisely when it has something to
      // report - that's the meaningful case here, not a transport error.
      if (res.status === 200 || res.status === 503) {
        const body = (await res.json()) as { ok: boolean; problems: string[] }
        out.cache = body.ok ? { ok: true } : { ok: false, error: body.problems.join(',') }
      } else {
        out.cache = { ok: false, error: `http_${res.status}` }
      }
    } catch (err) {
      out.cache = { ok: false, error: describeError(err) }
    }
  }

  if (settings.embeddingProvider === 'openai' && out.worker.ok) {
    try {
      const res = await fetch(`${settings.workerUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actually-Auth': settings.workerSecret,
        },
        body: JSON.stringify({ texts: ['ping'] }),
      })
      out.openai = res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
    } catch (err) {
      out.openai = { ok: false, error: describeError(err) }
    }
  }
  return out
}
