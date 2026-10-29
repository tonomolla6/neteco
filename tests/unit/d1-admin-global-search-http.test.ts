import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminGlobalSearchHttp } from '../../workers/auth/admin-global-search-http'
const origin = 'https://neteco.invalid',
  configuration = { password: 'synthetic-global-search-cookie-password-32', maxAgeSeconds: 3600 },
  now = () => '2026-10-08T12:00:00Z'
let sqlite: DatabaseSync, database: D1Database, cookie: string
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(deterministicTestData('global-search-http', now()).date())
  ;({ sqlite, database } = await categoryCommandFixture())
  cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const deps = () => ({
  database,
  sessionCookieConfiguration: configuration,
  origin,
  now,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-global-search-pepper-over-32'
})
const request = (query = '?q=acido', headers: Record<string, string> = {}) =>
  new Request(origin + '/api/admin/global-search' + query, {
    headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.99', ...headers }
  })
describe('global admin search HTTP', () => {
  it('returns a confirmed empty search with normalized query, private headers and no writes', async () => {
    const before = sqlite.prepare('SELECT total_changes() n').get(),
      response = await handleAdminGlobalSearchHttp(request('?q=%20A%CC%81CIDO%20&limit=5'), deps())
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ source: 'cloudflare', query: 'ÁCIDO', items: [] })
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('set-cookie')).toBeNull()
    expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it.each([
    '',
    '?q=a',
    '?q=' + 'x'.repeat(101),
    '?q=ab%0Acd',
    '?q=ab&q=cd',
    '?q=ab&limit=0',
    '?q=ab&limit=21',
    '?q=ab&limit=01',
    '?q=ab&limit=2&limit=2',
    '?q=ab&cursor=x',
    '?q=ab&now=2099'
  ])('rejects invalid query %s', async (query) => {
    expect((await handleAdminGlobalSearchHttp(request(query), deps()))?.status).toBe(400)
  })
  it('rejects absent/revoked cookie and unauthorized customer', async () => {
    expect((await handleAdminGlobalSearchHttp(request('?q=ab', { Cookie: '' }), deps()))?.status).toBe(401)
    sqlite.exec('DELETE FROM identity_roles')
    expect((await handleAdminGlobalSearchHttp(request(), deps()))?.status).toBe(403)
    sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'")
    expect((await handleAdminGlobalSearchHttp(request(), deps()))?.status).toBe(401)
  })
  it('rejects cross-site context and invalid configuration', async () => {
    expect(
      (await handleAdminGlobalSearchHttp(request('?q=ab', { Origin: 'https://evil.invalid' }), deps()))?.status
    ).toBe(403)
    expect(
      (await handleAdminGlobalSearchHttp(request('?q=ab', { 'Sec-Fetch-Site': 'cross-site' }), deps()))?.status
    ).toBe(403)
    expect((await handleAdminGlobalSearchHttp(request(), { ...deps(), origin: 'http://neteco.invalid' }))?.status).toBe(
      503
    )
  })
  it('fails closed for denied/unavailable edge controls and safe database failure', async () => {
    expect(
      (
        await handleAdminGlobalSearchHttp(request(), {
          ...deps(),
          edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
        })
      )?.status
    ).toBe(429)
    const unavailable = await handleAdminGlobalSearchHttp(request(), {
      ...deps(),
      edgeLimiter: {
        limit: async () => {
          throw new Error('private SQL token')
        }
      } as unknown as RateLimit
    })
    expect(unavailable?.status).toBe(503)
    expect(await unavailable!.json()).toEqual({ error: { code: 'unavailable' } })
    vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error('private database error')
    })
    expect(await (await handleAdminGlobalSearchHttp(request(), deps()))!.json()).toEqual({
      error: { code: 'unavailable' }
    })
  })
  it('owns exact GET only', async () => {
    expect(await handleAdminGlobalSearchHttp(new Request(origin + '/api/admin/global-search/other'), deps())).toBeNull()
    const response = await handleAdminGlobalSearchHttp(
      new Request(origin + '/api/admin/global-search', { method: 'POST' }),
      deps()
    )
    expect(response?.status).toBe(405)
    expect(response!.headers.get('allow')).toBe('GET')
  })
})
