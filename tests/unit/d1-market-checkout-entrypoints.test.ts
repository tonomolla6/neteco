import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
const origin = 'https://neteco.invalid'
const path = '/api/admin/checkout-markets/GB'
function fixture(enabled: boolean) {
  const prepare = vi.fn(() => {
    throw new Error('must not access database')
  })
  const limit = vi.fn(() => {
    throw new Error('must not access limiter')
  })
  return {
    prepare,
    limit,
    env: {
      APP_ENV: 'local',
      AUTH_ENABLED: enabled ? 'true' : 'false',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: 'synthetic-communications-dispatch-secret-over-32',
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-communications-dispatch-pepper-over-32',
      DB: { prepare },
      AUTH_EDGE_LIMIT: { limit },
      ADMIN_EDGE_LIMIT: { limit }
    } as unknown as CloudflareEnv
  }
}
it.each(['GET', 'POST'])('owns disabled %s without database or fallback', async (method) => {
  const f = fixture(false),
    response = await worker.fetch(new Request(origin + path, { method }), f.env)
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toContain('private')
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  expect(f.prepare).not.toHaveBeenCalled()
})
it('rejects unsupported methods before private access', async () => {
  const f = fixture(true),
    response = await worker.fetch(new Request(origin + path, { method: 'DELETE' }), f.env)
  expect(response.status).toBe(405)
  expect(response.headers.get('allow')).toBe('GET, POST')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.limit).not.toHaveBeenCalled()
})
it('mounts the public market profile read ahead of fallbacks and uses the cart edge limiter', async () => {
  const sql: string[] = []
  const limit = vi.fn(async () => ({ success: true }))
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: 'false',
    AUTH_ORIGIN: origin,
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-communications-dispatch-pepper-over-32',
    DB: {
      prepare: (query: string) => {
        sql.push(query)
        return { bind: () => ({ first: async () => null }) }
      }
    },
    CART_EDGE_LIMIT: { limit }
  } as unknown as CloudflareEnv
  const response = await worker.fetch(
    new Request(origin + '/api/checkout-markets/GB', { headers: { 'CF-Connecting-IP': '192.0.2.8' } }),
    env
  )
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: { code: 'not_found' } })
  expect(limit).toHaveBeenCalled()
  expect(sql.some((query) => query.includes('catalog_markets'))).toBe(true)
})
