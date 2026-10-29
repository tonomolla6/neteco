import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { handleAdminCompaniesHttp } from '../../workers/auth/admin-companies-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { companyFixture, CLAIMS, COMPANY, KEY, INPUT, OPTIONS, NOW, SESSION, ACTOR } from './d1-admin-companies-fixture'
let f: Awaited<ReturnType<typeof companyFixture>>, cookie: string
const origin = 'https://companies.neteco.test',
  configuration = { password: 'synthetic-company-cookie-secret-over-32', maxAgeSeconds: 3600 }
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  f = await companyFixture()
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
})
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: configuration,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-company-pepper-more-than32',
  now: OPTIONS.now
})
const req = (path = '', method = 'GET', body: unknown = INPUT) =>
  new Request(origin + '/api/admin/companies' + path, {
    method,
    headers: {
      cookie,
      origin,
      'CF-Connecting-IP': '192.0.2.9',
      'Content-Type': 'application/json',
      'Idempotency-Key': KEY
    },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {})
  })
it('completes private listing, review, exact replay and read-only receipt recovery', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect((await handleAdminCompaniesHttp(req('?q=B12345674&perPage=1'), deps()))?.status).toBe(200)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  const first = await handleAdminCompaniesHttp(req('/' + COMPANY, 'PUT'), deps())
  expect(first?.status).toBe(200)
  expect((await handleAdminCompaniesHttp(req('/' + COMPANY, 'PUT'), deps()))?.status).toBe(200)
  const saved = f.sqlite.prepare('SELECT total_changes() n').get(),
    response = await handleAdminCompaniesHttp(req(`/${COMPANY}/commands/${KEY}`), deps())
  expect(await response!.json()).toMatchObject({
    outcome: 'applied',
    receipt: { companyId: COMPANY, commandId: KEY, status: 'approved' }
  })
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(response!.headers.get('vary')).toBe('Cookie')
  expect(response!.headers.has('set-cookie')).toBe(false)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(saved)
})
it.each(['?page=0', '?page=1.5', '?perPage=51', '?q=a&q=b', '?status=other', '?unknown=x', '?q=' + 'x'.repeat(101)])(
  'rejects malformed listing %s',
  async (path) => {
    expect((await handleAdminCompaniesHttp(req(path), deps()))?.status).toBe(400)
  }
)
it.each(['missing', 'foreign', 'cross-site'])('blocks %s CSRF without quota or review writes', async (mode) => {
  const r = req('/' + COMPANY, 'PUT')
  if (mode === 'missing') r.headers.delete('origin')
  if (mode === 'foreign') r.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'cross-site') r.headers.set('sec-fetch-site', 'cross-site')
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect((await handleAdminCompaniesHttp(r, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it.each(['anonymous', 'customer', 'email', 'mfa', 'revoked'])('denies %s access before quota writes', async (mode) => {
  const r = req('/' + COMPANY, 'PUT')
  if (mode === 'anonymous') r.headers.delete('cookie')
  if (mode === 'customer') f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(ACTOR)
  if (mode === 'email') f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ACTOR)
  if (mode === 'mfa') f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(SESSION)
  if (mode === 'revoked') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect((await handleAdminCompaniesHttp(r, deps()))?.status).toBe(
    mode === 'anonymous' || mode === 'revoked' ? 401 : 403
  )
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('enforces methods and namespace before database access', async () => {
  const d = {
    ...deps(),
    database: {
      prepare() {
        throw new Error('unexpected_db')
      }
    } as unknown as D1Database
  }
  const r = await handleAdminCompaniesHttp(req('/' + COMPANY, 'DELETE'), d)
  expect(r?.status).toBe(405)
  expect(r?.headers.get('allow')).toBe('PUT')
  expect((await handleAdminCompaniesHttp(req(`/${COMPANY}/commands/${KEY}`, 'POST'), d))?.headers.get('allow')).toBe(
    'GET'
  )
  expect(await handleAdminCompaniesHttp(new Request(origin + '/api/companies'), d)).toBeNull()
})
it('bounds body bytes and fails closed on edge or identity quota', async () => {
  expect(
    (await handleAdminCompaniesHttp(req('/' + COMPANY, 'PUT', { ...INPUT, reason: 'x'.repeat(9000) }), deps()))?.status
  ).toBe(413)
  expect(
    (
      await handleAdminCompaniesHttp(req(), {
        ...deps(),
        edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
      })
    )?.status
  ).toBe(429)
  f.sqlite
    .prepare('INSERT INTO identity_rate_limits VALUES(?,?,?,?,?)')
    .run(ACTOR, 'admin-company-review', 60, Date.parse(NOW) / 1000, Date.parse(NOW) / 1000 + 3600)
  expect((await handleAdminCompaniesHttp(req('/' + COMPANY, 'PUT'), deps()))?.status).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 0 })
})
