import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://neteco.invalid'
const orderId = '10000000-0000-4000-8000-000000000001'
const commandKey = '20000000-0000-4000-8000-000000000001'
const routes = [`/api/orders/${orderId}/cancellation`, `/api/admin/orders/${orderId}/cancellation`]
const receiptRoutes = routes.map((path) => `${path}/commands/${commandKey}`)
function guardedEnvironment(enabled: boolean) {
  const prepare = vi.fn(() => {
    throw new Error('Dispatcher gate must not reach D1')
  })
  const edgeLimit = vi.fn(async () => {
    throw new Error('Method gate must precede authentication/rate limiting')
  })
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-cancellation-dispatch-secret-over-32',
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-cancellation-dispatch-pepper-over-32',
    DB: { prepare },
    AUTH_EDGE_LIMIT: { limit: edgeLimit },
    ADMIN_EDGE_LIMIT: { limit: edgeLimit }
  } as unknown as CloudflareEnv
  return { env, prepare, edgeLimit }
}
function assertPrivateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toContain('private')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}
describe('order cancellation ownership at actual Worker dispatcher', () => {
  it.each([...routes, ...receiptRoutes].flatMap((path) => ['GET', 'POST'].map((method) => ({ path, method }))))(
    'owns disabled $method $path without legacy fallback',
    async ({ path, method }) => {
      const fixture = guardedEnvironment(false)
      const response = await worker.fetch(new Request(origin + path, { method }), fixture.env)
      expect(response.status).toBe(503)
      assertPrivateResponse(response)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.edgeLimit).not.toHaveBeenCalled()
    }
  )
  it.each(routes)('rejects enabled DELETE %s before auth/DB and advertises GET, POST', async (path) => {
    const fixture = guardedEnvironment(true)
    const response = await worker.fetch(new Request(origin + path, { method: 'DELETE' }), fixture.env)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
    assertPrivateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.edgeLimit).not.toHaveBeenCalled()
  })
  it.each(receiptRoutes)('rejects enabled POST %s before auth/DB, keeping receipt GET-only', async (path) => {
    const fixture = guardedEnvironment(true)
    const response = await worker.fetch(new Request(origin + path, { method: 'POST' }), fixture.env)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    assertPrivateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.edgeLimit).not.toHaveBeenCalled()
  })
  it.each([`/api/orders/${orderId}/unrelated-cancellation-feature`, '/api/admin/unrelated-cancellation-feature'])(
    'preserves unrelated missing route %s',
    async (path) => {
      const fixture = guardedEnvironment(false)
      const response = await worker.fetch(new Request(origin + path), fixture.env)
      expect(response.status).toBe(404)
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.edgeLimit).not.toHaveBeenCalled()
    }
  )
})
