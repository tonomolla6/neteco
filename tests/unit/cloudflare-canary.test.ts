import { describe, expect, it, vi } from 'vitest'
import worker, { inspectCanaryBindings } from '../../workers/canary'

function bindings(options: { d1Ok?: boolean; categories?: unknown[]; categoryError?: Error } = {}) {
  const first = vi.fn().mockResolvedValue(options.d1Ok === false ? null : { ok: 1 })
  const all = options.categoryError
    ? vi.fn().mockRejectedValue(options.categoryError)
    : vi.fn().mockResolvedValue({ results: options.categories ?? [] })
  return {
    APP_ENV: 'canary',
    DB: { prepare: vi.fn(() => ({ first, all })) },
    CACHE: { get: vi.fn(), put: vi.fn() },
    MEDIA: { get: vi.fn(), put: vi.fn() },
    ASYNC_JOBS: { send: vi.fn() },
    CATALOG_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    COORDINATOR: { idFromName: vi.fn(), get: vi.fn() },
    INVENTORY: { idFromName: vi.fn(), get: vi.fn() }
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
      inventory: { ok: true },
      kv: { ok: true },
      queues: { ok: true },
      r2: { ok: true },
      workflows: { ok: true }
    })
    expect(env.ASYNC_JOBS.send).not.toHaveBeenCalled()
    expect(env.CACHE.put).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(env.COORDINATOR.get).not.toHaveBeenCalled()
    expect(env.CATALOG_WORKFLOW.create).not.toHaveBeenCalled()
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

  it('serves categories from D1 with an explicit public cache policy', async () => {
    const response = await worker.fetch(
      new Request('https://canary.neteco.invalid/api/categories'),
      bindings({
        categories: [
          {
            id: 7,
            name: 'Productos químicos',
            slug: 'productos-quimicos',
            parentId: null,
            sort: 7,
            directCount: 0
          }
        ]
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300')
    await expect(response.json()).resolves.toMatchObject({ roots: [{ id: 7, count: 0 }] })
  })

  it('turns a D1 catalog failure into a generic, private 503 response', async () => {
    const response = await worker.fetch(
      new Request('https://canary.neteco.invalid/api/categories'),
      bindings({ categoryError: new Error('sensitive D1 detail') })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'catalog_unavailable' })
  })
})
