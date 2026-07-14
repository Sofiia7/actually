import { describe, expect, it } from 'vitest'
import { resolvePublishDefaults } from './publishDefaults'

const ENV_LOCAL = [
  'VITE_BUILDER_CODE=0xabc123',
  'VITE_WC_PROJECT_ID=deadbeef',
  'VITE_WORKER_URL=https://actually-api.example.workers.dev',
  'VITE_WORKER_SECRET=s3cret-from-file',
].join('\n')

describe('resolvePublishDefaults', () => {
  it('explicit env vars win over .env.local contents', () => {
    const d = resolvePublishDefaults({
      env: {
        ACTUALLY_BUILDER_CODE: '0xffff',
        ACTUALLY_WORKER_URL: 'https://override.example',
        ACTUALLY_WORKER_SECRET: 'env-secret',
      },
      envLocalText: ENV_LOCAL,
      isPublish: false,
    })
    expect(d.builderCode).toBe('0xffff')
    expect(d.workerUrl).toBe('https://override.example')
    expect(d.workerSecret).toBe('env-secret')
  })

  it('falls back to extension/.env.local for worker url/secret when env vars are absent', () => {
    const d = resolvePublishDefaults({ env: {}, envLocalText: ENV_LOCAL, isPublish: false })
    expect(d.workerUrl).toBe('https://actually-api.example.workers.dev')
    expect(d.workerSecret).toBe('s3cret-from-file')
  })

  it('NEVER reads the builder code from .env.local — baking it must stay an explicit decision (open ToS question R1)', () => {
    const d = resolvePublishDefaults({ env: {}, envLocalText: ENV_LOCAL, isPublish: false })
    expect(d.builderCode).toBe('')
  })

  it('throws on publish builds when worker url/secret resolve empty — a published package must never ship dead check_news', () => {
    expect(() => resolvePublishDefaults({ env: {}, envLocalText: undefined, isPublish: true })).toThrow(
      /worker url|ACTUALLY_WORKER_URL/i,
    )
  })

  it('allows empty defaults on ordinary (non-publish) builds — CI has no .env.local and mocks the store', () => {
    const d = resolvePublishDefaults({ env: {}, envLocalText: undefined, isPublish: false })
    expect(d.workerUrl).toBe('')
    expect(d.workerSecret).toBe('')
  })
})
