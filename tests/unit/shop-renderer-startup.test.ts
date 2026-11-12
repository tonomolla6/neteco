import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  evaluated: vi.fn(),
  render: vi.fn(),
  api: vi.fn(),
  scheduled: vi.fn(),
  queue: vi.fn()
}))

vi.mock('../../workers/canary', () => ({
  default: { fetch: mocks.api, scheduled: mocks.scheduled, queue: mocks.queue },
  CanaryCoordinator: vi.fn(),
  CanaryWorkflow: vi.fn(),
  InventoryCoordinator: vi.fn(),
  CartCoordinator: vi.fn()
}))
vi.mock('../../workers/catalog/category-redirects', () => ({ handleD1CategoryRedirect: async () => null }))
vi.mock('../../workers/cms/public-http', () => ({ resolveCmsPublicRedirect: async () => null }))
vi.mock('../../workers/runtime/operations-config', () => ({ cmsRuntimeDependencies: () => ({}) }))

const env = { APP_ENV: 'test', CSP_MODE: 'off' } as CloudflareEnv
const context = {} as ExecutionContext

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('#neteco/nitro-renderer', () => {
    mocks.evaluated()
    return { default: { fetch: mocks.render } }
  })
  mocks.render.mockImplementation(async (request: Request) => new Response(request.url))
  mocks.api.mockResolvedValue(Response.json({ ok: true }))
})

describe('Worker renderer startup', () => {
  it('does not evaluate the Nitro graph during startup or API, cron and queue dispatch', async () => {
    const { default: shop } = await import('../../workers/shop')
    expect(mocks.evaluated).not.toHaveBeenCalled()
    const response = await shop.fetch(new Request('https://shop.invalid/api/products'), env, context)
    expect(response.status).toBe(200)
    await shop.scheduled({} as ScheduledController, env, context)
    await shop.queue({} as MessageBatch, env, context)
    expect(mocks.api).toHaveBeenCalledOnce()
    expect(mocks.scheduled).toHaveBeenCalledOnce()
    expect(mocks.queue).toHaveBeenCalledOnce()
    expect(mocks.evaluated).not.toHaveBeenCalled()
  })

  it('loads Nitro once on the first concurrent page requests and preserves their bindings', async () => {
    const { default: shop } = await import('../../workers/shop')
    expect(mocks.evaluated).not.toHaveBeenCalled()
    const requests = ['/catalogo', '/producto/olla-alta-con-tapa'].map(
      (path) => new Request(`https://shop.invalid${path}`)
    )
    const responses = await Promise.all(requests.map((request) => shop.fetch(request, env, context)))
    expect(mocks.evaluated).toHaveBeenCalledOnce()
    for (const [index, request] of requests.entries()) {
      expect(await responses[index]!.text()).toBe(request.url)
      expect(mocks.render).toHaveBeenCalledWith(request, env, context)
    }
  })

  it('keeps renderer failures closed and allows the following request to render', async () => {
    const { default: shop } = await import('../../workers/shop')
    mocks.render.mockRejectedValueOnce(new Error('transient renderer failure'))
    const request = new Request('https://shop.invalid/catalogo')
    const failed = await shop.fetch(request, env, context)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: { code: 'renderer_unavailable' } })
    expect((await shop.fetch(request, env, context)).status).toBe(200)
    expect(mocks.evaluated).toHaveBeenCalledOnce()
  })

  it('rejects invalid aliases and unsupported page methods without loading Nitro', async () => {
    const { default: shop } = await import('../../workers/shop')
    expect((await shop.fetch(new Request('https://shop.invalid/%61pi/products'), env, context)).status).toBe(400)
    expect(
      (await shop.fetch(new Request('https://shop.invalid/catalogo', { method: 'POST' }), env, context)).status
    ).toBe(405)
    expect(mocks.evaluated).not.toHaveBeenCalled()
  })
})
