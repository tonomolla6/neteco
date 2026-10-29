import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://neteco.invalid'
const orderId = '10000000-0000-4000-8000-000000000001'
const key = '10000000-0000-4000-8000-000000000002'
const path = `/api/admin/orders/${orderId}/annotations`
function fixture(enabled: boolean) {
  const prepare = vi.fn(() => {
    throw new Error('Dispatcher gate must precede private annotations D1 access')
  })
  const limit = vi.fn(() => {
    throw new Error('Method gate must precede edge/session lookup')
  })
  return {
    prepare,
    limit,
    env: {
      APP_ENV: 'local',
      AUTH_ENABLED: enabled ? 'true' : 'false',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: 'synthetic-order-annotation-dispatch-secret-over-32',
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-order-annotation-dispatch-pepper-over-32',
      DB: { prepare },
      AUTH_EDGE_LIMIT: { limit },
      ADMIN_EDGE_LIMIT: { limit }
    } as unknown as CloudflareEnv
  }
}
function privateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toContain('private')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}
describe('private order annotations dispatcher ownership', () => {
  it.each([
    ['GET', path],
    ['POST', path],
    ['GET', `${path}/commands/${key}`],
    ['POST', `${path}/commands/${key}`]
  ])('owns disabled %s %s without a database or legacy fallback', async (method, target) => {
    const context = fixture(false)
    const response = await worker.fetch(new Request(origin + target, { method }), context.env)
    expect(response.status).toBe(503)
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(context.prepare).not.toHaveBeenCalled()
    expect(context.limit).not.toHaveBeenCalled()
  })
  it.each([
    ['DELETE', path, 'GET, POST'],
    ['POST', `${path}/commands/${key}`, 'GET']
  ])('rejects enabled %s %s before private access', async (method, target, allow) => {
    const context = fixture(true)
    const response = await worker.fetch(new Request(origin + target, { method }), context.env)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe(allow)
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(context.prepare).not.toHaveBeenCalled()
    expect(context.limit).not.toHaveBeenCalled()
  })
  it.each([`${path}/unrelated-feature`, `/api/orders/${orderId}/annotations`])(
    'does not expose a customer or unrelated annotations route: %s',
    async (target) => {
      const context = fixture(false)
      const response = await worker.fetch(new Request(origin + target), context.env)
      expect(response.status).toBe(404)
      expect(context.prepare).not.toHaveBeenCalled()
      expect(context.limit).not.toHaveBeenCalled()
    }
  )
})
