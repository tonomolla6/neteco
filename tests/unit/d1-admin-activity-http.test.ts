import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminActivityHttp } from '../../workers/auth/admin-activity-http'
import { deterministicTestData } from '../fixtures/deterministic'
import { testNow } from '../support/deterministic'
const origin = 'https://neteco.invalid'
const configuration = { password: 'synthetic-admin-activity-cookie-password-32', maxAgeSeconds: 3600 }
let sqlite: DatabaseSync, database: D1Database, cookie: string
const now = () => new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(deterministicTestData('activity-http', '2026-10-08T12:00:00.000Z').date())
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
  rateLimitPepper: 'synthetic-admin-activity-pepper-over-32'
})
const request = (suffix = '', headers: Record<string, string> = {}) =>
  new Request(origin + '/api/admin/activity' + suffix, {
    headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.99', ...headers }
  })
describe('private read-only activity HTTP contract', () => {
  it('returns a genuine empty audit feed with safe private headers and no writes', async () => {
    const before = sqlite.prepare('SELECT total_changes() AS changes').get()
    const response = await handleAdminActivityHttp(request('?limit=5'), deps())
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ source: 'cloudflare', items: [], nextCursor: null })
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('x-robots-tag')).toContain('noindex')
    expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })
  it('rejects missing cookie, revoked session and CSRF context', async () => {
    expect((await handleAdminActivityHttp(request('', { Cookie: '' }), deps()))?.status).toBe(401)
    expect((await handleAdminActivityHttp(request('', { Origin: 'https://evil.invalid' }), deps()))?.status).toBe(403)
    expect((await handleAdminActivityHttp(request('', { 'Sec-Fetch-Site': 'cross-site' }), deps()))?.status).toBe(403)
    sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'")
    expect((await handleAdminActivityHttp(request(), deps()))?.status).toBe(401)
  })
  it.each([
    '?limit=0',
    '?limit=21',
    '?limit=1.5',
    '?limit=01',
    '?limit=5&limit=5',
    '?now=2099-01-01T00:00:00Z',
    '?cursor=x',
    '?cursor='
  ])('rejects noncontract query %s', async (query) => {
    expect((await handleAdminActivityHttp(request(query), deps()))?.status).toBe(400)
  })
  it('fails closed for denied or unavailable edge controls', async () => {
    const limited = await handleAdminActivityHttp(request(), {
      ...deps(),
      edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
    })
    expect(limited?.status).toBe(429)
    const unavailable = await handleAdminActivityHttp(request(), {
      ...deps(),
      edgeLimiter: {
        limit: async () => {
          throw new Error('secret limiter error')
        }
      } as unknown as RateLimit
    })
    expect(unavailable?.status).toBe(503)
    expect(await unavailable!.json()).toEqual({ error: { code: 'unavailable' } })
  })
  it('owns GET only and leaves unrelated routes alone', async () => {
    expect(await handleAdminActivityHttp(new Request(origin + '/api/admin/elsewhere'), deps())).toBeNull()
    const response = await handleAdminActivityHttp(
      new Request(origin + '/api/admin/activity', { method: 'POST' }),
      deps()
    )
    expect(response?.status).toBe(405)
    expect(response!.headers.get('allow')).toBe('GET')
  })
})
