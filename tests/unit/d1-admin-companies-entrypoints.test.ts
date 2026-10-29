import { it, expect, vi } from 'vitest'
import worker from '../../workers/canary'
import { companyFixture, CLAIMS, COMPANY, KEY, INPUT, NOW } from './d1-admin-companies-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
const origin = 'https://companies.neteco.test',
  configuration = { password: 'synthetic-company-cookie-secret-over-32', maxAgeSeconds: 3600 }
it.each([
  ['GET', '/api/admin/companies'],
  ['PUT', '/api/admin/companies/' + COMPANY],
  ['GET', `/api/admin/companies/${COMPANY}/commands/${KEY}`]
])('owns disabled %s %s without DB or Node fallback', async (method, path) => {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_db')
  })
  const response = await worker.fetch(new Request(origin + path, { method }), {
    APP_ENV: 'local',
    AUTH_ENABLED: 'false',
    DB: { prepare }
  } as unknown as CloudflareEnv)
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(prepare).not.toHaveBeenCalled()
})
it('routes current signed admin cookie through real Worker list, PUT and receipt without GET writes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  const f = await companyFixture()
  try {
    const cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!,
      env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: configuration.password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-company-pepper-more-than32',
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        DB: f.database
      } as unknown as CloudflareEnv
    const request = (path: string, method = 'GET') =>
      new Request(origin + path, {
        method,
        headers: {
          cookie,
          origin,
          'CF-Connecting-IP': '192.0.2.64',
          'Content-Type': 'application/json',
          'Idempotency-Key': KEY
        },
        ...(method === 'PUT' ? { body: JSON.stringify(INPUT) } : {})
      })
    expect((await worker.fetch(request('/api/admin/companies'), env)).status).toBe(200)
    expect((await worker.fetch(request('/api/admin/companies/' + COMPANY, 'PUT'), env)).status).toBe(200)
    const before = f.sqlite.prepare('SELECT total_changes() n').get(),
      receipt = await worker.fetch(request(`/api/admin/companies/${COMPANY}/commands/${KEY}`), env)
    expect(await receipt.json()).toMatchObject({
      outcome: 'applied',
      receipt: { companyId: COMPANY, status: 'approved' }
    })
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  } finally {
    f.sqlite.close()
    vi.useRealTimers()
  }
})
