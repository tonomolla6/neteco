import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://neteco.invalid'
const orderId = '10000000-0000-4000-8000-000000000001'
const routes = [`/api/orders/${orderId}/timeline`, `/api/admin/orders/${orderId}/timeline`]
function guardedEnvironment(enabled: boolean) {
  const prepare = vi.fn(() => {
    throw new Error('Entrypoint gate must not access D1')
  })
  const edgeLimit = vi.fn(async () => {
    throw new Error('Method gate must not reach authentication/rate limiting')
  })
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-entrypoint-secret-longer-than-32-characters',
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-entrypoint-pepper-longer-than-32-characters',
    DB: { prepare },
    AUTH_EDGE_LIMIT: { limit: edgeLimit },
    ADMIN_EDGE_LIMIT: { limit: edgeLimit }
  } as unknown as CloudflareEnv
  return { env, prepare, edgeLimit }
}
function expectPrivateReadOnlyResponse(response: Response) {
  expect(response.headers.get('cache-control')).toContain('private')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}

describe('order timeline entrypoints through the actual Worker dispatcher', () => {
  it.each(routes.flatMap((path) => ['GET', 'POST'].map((method) => ({ path, method }))))(
    'owns disabled $method $path without DB or a legacy fallback',
    async ({ path, method }) => {
      const fixture = guardedEnvironment(false)
      const response = await worker.fetch(new Request(origin + path, { method }), fixture.env)
      expect(response.status).toBe(503)
      expectPrivateReadOnlyResponse(response)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.edgeLimit).not.toHaveBeenCalled()
    }
  )
  it.each(routes)('rejects enabled POST %s before auth/DB', async (path) => {
    const fixture = guardedEnvironment(true)
    const response = await worker.fetch(new Request(origin + path, { method: 'POST' }), fixture.env)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expectPrivateReadOnlyResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.edgeLimit).not.toHaveBeenCalled()
  })
  it.each([`/api/orders/${orderId}/unrelated-native-feature`, '/api/admin/unrelated-native-feature'])(
    'preserves unrelated missing path %s as 404',
    async (path) => {
      const fixture = guardedEnvironment(false)
      const response = await worker.fetch(new Request(origin + path), fixture.env)
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.edgeLimit).not.toHaveBeenCalled()
    }
  )
})
