import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const boundary = vi.hoisted(() => ({ consume: vi.fn(), dispatch: vi.fn() }))
vi.mock('../../workers/fulfillment/bulk-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workers/fulfillment/bulk-runtime')>()),
  consumeAdminOrderBulkMessage: boundary.consume,
  dispatchAdminOrderBulkRequests: boundary.dispatch
}))
const ORIGIN = 'https://bulk-ingress.neteco.invalid'
const message = () => ({
  body: { type: 'admin.order-bulk.requested', groupId: crypto.randomUUID(), dispatchId: crypto.randomUUID() },
  ack: vi.fn(),
  retry: vi.fn(),
  attempts: 1
})
function environment(enabled = true) {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_private_read')
  })
  return {
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: ORIGIN,
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-bulk-ingress-pepper-32-characters',
    NUXT_SESSION_PASSWORD: 'synthetic-bulk-ingress-password-32-characters',
    DB: { prepare },
    ADMIN_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    ASYNC_JOBS: { send: vi.fn(async () => {}) }
  } as unknown as CloudflareEnv
}

beforeEach(() => {
  boundary.consume.mockReset().mockResolvedValue('completed')
  boundary.dispatch.mockReset().mockResolvedValue({ selected: 0, sent: 0, failed: 0 })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('canary owns bulk routes and bounded continuation deliveries', () => {
  it('keeps the complete bulk namespace fail-closed while authentication is disabled', async () => {
    const env = environment(false)
    const result = await worker.fetch(
      new Request(ORIGIN + '/api/admin/orders/bulk-fulfillment/preview', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.86' },
        body: '{}'
      }),
      env
    )
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('applies its edge limit before cookie, body or any D1 access', async () => {
    const env = environment()
    vi.mocked(env.ADMIN_EDGE_LIMIT.limit).mockResolvedValue({ success: false })
    const result = await worker.fetch(
      new Request(ORIGIN + '/api/admin/orders/bulk-fulfillment/preview', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.86' },
        body: '{}'
      }),
      env
    )
    expect(result.status).toBe(429)
    expect(await result.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(env.ADMIN_EDGE_LIMIT.limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it.each(['completed', 'requeued', 'invalid'] as const)(
    'acknowledges only the classified %s delivery',
    async (outcome) => {
      const env = environment(),
        item = message()
      boundary.consume.mockResolvedValue(outcome)
      await worker.queue({ messages: [item] } as unknown as MessageBatch, env)
      expect(boundary.consume).toHaveBeenCalledOnce()
      expect(boundary.consume).toHaveBeenCalledWith(
        env.DB,
        item.body,
        expect.objectContaining({
          enabled: true,
          queue: expect.objectContaining({ send: expect.any(Function) })
        })
      )
      expect(item.ack).toHaveBeenCalledOnce()
      expect(item.retry).not.toHaveBeenCalled()
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
  )

  it.each(['retry', 'disabled'] as const)(
    'preserves the %s obligation instead of blind acknowledgment',
    async (outcome) => {
      const env = environment(outcome !== 'disabled'),
        item = message()
      boundary.consume.mockResolvedValue(outcome)
      await worker.queue({ messages: [item] } as unknown as MessageBatch, env)
      expect(boundary.consume).toHaveBeenCalledOnce()
      expect(item.retry).toHaveBeenCalledOnce()
      expect(item.ack).not.toHaveBeenCalled()
    }
  )

  it('limits bulk work to one delivery per queue invocation, requeuing overflow without exhausting retry budgets', async () => {
    const env = environment(),
      items = Array.from({ length: 10 }, message)
    await worker.queue({ messages: items } as unknown as MessageBatch, env)
    expect(boundary.consume).toHaveBeenCalledOnce()
    expect(items[0]!.ack).toHaveBeenCalledOnce()
    expect(env.ASYNC_JOBS.send).toHaveBeenCalledTimes(9)
    for (const item of items.slice(1)) {
      expect(env.ASYNC_JOBS.send).toHaveBeenCalledWith(item.body)
      expect(item.retry).not.toHaveBeenCalled()
      expect(item.ack).toHaveBeenCalledOnce()
    }
  })

  it('keeps overflow unacknowledged if continuation publication fails', async () => {
    const env = environment(),
      items = [message(), message()]
    vi.mocked(env.ASYNC_JOBS.send).mockRejectedValue(new Error('synthetic_queue_outage'))
    await worker.queue({ messages: items } as unknown as MessageBatch, env)
    expect(boundary.consume).toHaveBeenCalledOnce()
    expect(items[0]!.ack).toHaveBeenCalledOnce()
    expect(items[1]!.ack).not.toHaveBeenCalled()
    expect(items[1]!.retry).toHaveBeenCalledOnce()
  })

  it('acknowledges invalid overflow without republishing injected commands or reading D1', async () => {
    const env = environment(),
      first = message(),
      invalid = message()
    Object.assign(invalid.body, { actorId: crypto.randomUUID() })
    await worker.queue({ messages: [first, invalid] } as unknown as MessageBatch, env)
    expect(boundary.consume).toHaveBeenCalledOnce()
    expect(env.ASYNC_JOBS.send).not.toHaveBeenCalled()
    expect(invalid.ack).toHaveBeenCalledOnce()
    expect(invalid.retry).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('retries an unclassified runtime failure without falling through to the inventory consumer', async () => {
    const env = environment(),
      item = message()
    boundary.consume.mockRejectedValue(new Error('synthetic_runtime_outage'))
    await worker.queue({ messages: [item] } as unknown as MessageBatch, env)
    expect(item.retry).toHaveBeenCalledOnce()
    expect(item.ack).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('gives pending durable bulk work a bounded Cron recovery opportunity even if unrelated stages fail', async () => {
    const env = environment()
    await expect(worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, env)).rejects.toBeInstanceOf(
      AggregateError
    )
    expect(boundary.dispatch).toHaveBeenCalledOnce()
    expect(boundary.dispatch).toHaveBeenCalledWith(
      env.DB,
      env.ASYNC_JOBS,
      expect.objectContaining({ enabled: true, limit: 5 })
    )
  })
})
