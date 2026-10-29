import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://neteco.invalid'
const path = '/api/admin/orders/export.csv'
function fixture(enabled: boolean) {
  const prepare = vi.fn(() => {
    throw new Error('Export dispatcher gate must not reach D1')
  })
  const limit = vi.fn(() => {
    throw new Error('Method gate must precede auth/edge lookup')
  })
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-order-export-dispatch-secret-over-32',
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-order-export-dispatch-pepper-over-32',
    DB: { prepare },
    AUTH_EDGE_LIMIT: { limit },
    ADMIN_EDGE_LIMIT: { limit }
  } as unknown as CloudflareEnv
  return { env, prepare, limit }
}
function privateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toContain('private')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
}
describe('order CSV export ownership at actual Worker dispatcher', () => {
  it.each(['GET', 'POST'])('owns disabled %s export without D1 or legacy fallback', async (method) => {
    const context = fixture(false)
    const response = await worker.fetch(new Request(origin + path, { method }), context.env)
    expect(response.status).toBe(503)
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(context.prepare).not.toHaveBeenCalled()
    expect(context.limit).not.toHaveBeenCalled()
  })
  it('rejects enabled POST before auth/DB and advertises GET only', async () => {
    const context = fixture(true)
    const response = await worker.fetch(new Request(origin + path, { method: 'POST' }), context.env)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(context.prepare).not.toHaveBeenCalled()
    expect(context.limit).not.toHaveBeenCalled()
  })
  it('preserves an unrelated missing export subroute', async () => {
    const context = fixture(false)
    const response = await worker.fetch(new Request(origin + path + '/unrelated-feature'), context.env)
    expect(response.status).toBe(404)
    expect(context.prepare).not.toHaveBeenCalled()
    expect(context.limit).not.toHaveBeenCalled()
  })
})
