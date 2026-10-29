import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'

const origin = 'https://order-views.neteco.test'

describe('Cloudflare private order-view ingress', () => {
  it.each([
    '/api/admin/order-views',
    '/api/admin/order-views/00000000-0000-4000-8000-000000000001',
    '/api/admin/order-views/commands/00000000-0000-4000-8000-000000000002',
    '/API/admin/order-views',
    '/api/admin/%6frder-views'
  ])('owns disabled namespace %s without reaching D1 or the legacy application', async (path) => {
    const env = environment({ AUTH_ENABLED: 'false', AUTH_ORIGIN: origin })
    const response = await worker.fetch(new Request(origin + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('runs the dedicated edge gate before cookie parsing, body reads or D1 authority', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, ADMIN_EDGE_LIMIT: { limit } })
    const response = await worker.fetch(
      new Request(origin + '/api/admin/order-views', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '192.0.2.86', origin, 'content-type': 'application/json' },
        body: '{not-json'
      }),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
})
