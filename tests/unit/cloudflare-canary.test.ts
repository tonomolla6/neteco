import { describe, expect, it, vi } from 'vitest'
import worker, { inspectCanaryBindings } from '../../workers/canary'

function bindings(options: { d1Ok?: boolean } = {}) {
  const first = vi.fn().mockResolvedValue(options.d1Ok === false ? null : { ok: 1 })
  return {
    APP_ENV: 'canary',
    DB: { prepare: vi.fn(() => ({ first })) },
    CACHE: { get: vi.fn(), put: vi.fn() },
    MEDIA: { get: vi.fn(), put: vi.fn() },
    ASYNC_JOBS: { send: vi.fn() },
    COORDINATOR: { idFromName: vi.fn(), get: vi.fn() }
  } as unknown as CloudflareEnv
}

describe('Cloudflare canary', () => {
  it('reports every required binding without mutating queues, KV, R2 or Durable Objects', async () => {
    const env = bindings()
    const result = await inspectCanaryBindings(env)

    expect(result.ok).toBe(true)
    expect(result.checks).toEqual({
      d1: { ok: true },
      durableObjects: { ok: true },
      kv: { ok: true },
      queues: { ok: true },
      r2: { ok: true }
    })
    expect(env.ASYNC_JOBS.send).not.toHaveBeenCalled()
    expect(env.CACHE.put).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(env.COORDINATOR.get).not.toHaveBeenCalled()
  })

  it('returns 503 and no-store when the D1 probe fails', async () => {
    const response = await worker.fetch(new Request('https://canary.neteco.invalid/health'), bindings({ d1Ok: false }))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ ok: false, checks: { d1: { ok: false } } })
  })

  it('does not expose routes other than the health probe', async () => {
    const response = await worker.fetch(new Request('https://canary.neteco.invalid/'), bindings())
    expect(response.status).toBe(404)
  })
})
