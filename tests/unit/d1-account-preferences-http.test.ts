import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { handleAccountPreferencesHttp } from '../../workers/auth/account-preferences-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import {
  preferencesFixture,
  CLAIMS,
  KEY,
  OPTIONS,
  NOW,
  ACTOR,
  SESSION,
  CUSTOMER
} from './d1-account-preferences-fixture'
let f: Awaited<ReturnType<typeof preferencesFixture>>, cookie: string
const origin = 'https://preferences.neteco.test',
  configuration = { password: 'synthetic-preference-cookie-secret-more32', maxAgeSeconds: 3600 }
const INPUT = {
  expectedVersion: 0,
  policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
  preferences: { product_updates: true, replenishment: false }
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  f = await preferencesFixture(true)
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
})
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: configuration,
  origin,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-preferences-edge-pepper-more32',
  now: OPTIONS.now
})
const request = (path = '', method = 'GET', body: unknown = INPUT) =>
  new Request(origin + '/api/account/preferences' + path, {
    method,
    headers: {
      cookie,
      origin,
      'CF-Connecting-IP': '192.0.2.18',
      'Content-Type': 'application/json',
      'Idempotency-Key': KEY
    },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {})
  })
it('completes signed-cookie explicit update/replay, strict private current state and read-only receipt', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  const first = await handleAccountPreferencesHttp(request(), deps())
  expect(first?.status).toBe(200)
  expect(await first!.json()).toMatchObject({
    version: 0,
    preferences: { product_updates: false, replenishment: false }
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  const applied = await handleAccountPreferencesHttp(request('', 'PUT'), deps())
  expect(applied?.status).toBe(200)
  expect((await handleAccountPreferencesHttp(request('', 'PUT'), deps()))?.status).toBe(200)
  const saved = f.sqlite.prepare('SELECT total_changes() n').get(),
    recovered = await handleAccountPreferencesHttp(request('/commands/' + KEY), deps())
  expect(await recovered!.json()).toMatchObject({ outcome: 'applied', receipt: { commandId: KEY, version: 1 } })
  expect(recovered!.headers.get('cache-control')).toBe('private, no-store')
  expect(recovered!.headers.get('vary')).toBe('Cookie')
  expect(recovered!.headers.has('set-cookie')).toBe(false)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(saved)
})
it.each(['missing', 'foreign', 'cross-site'])('rejects %s CSRF without DB effects', async (kind) => {
  const r = request('', 'PUT')
  if (kind === 'missing') r.headers.delete('origin')
  if (kind === 'foreign') r.headers.set('origin', 'https://foreign.invalid')
  if (kind === 'cross-site') r.headers.set('sec-fetch-site', 'cross-site')
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect((await handleAccountPreferencesHttp(r, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it.each(['anonymous', 'revoked', 'email', 'blocked-customer'])(
  'rejects %s before quota or consent writes',
  async (kind) => {
    const r = request('', 'PUT')
    if (kind === 'anonymous') r.headers.delete('cookie')
    if (kind === 'revoked') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
    if (kind === 'email') f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ACTOR)
    if (kind === 'blocked-customer') f.sqlite.prepare("UPDATE customers SET status='blocked' WHERE id=?").run(CUSTOMER)
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    expect((await handleAccountPreferencesHttp(r, deps()))?.status).toBe(kind === 'email' ? 403 : 401)
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  }
)
it.each(['?q=x', '?x=a&x=b', '/commands/bad', '/commands/' + KEY + '?x=1'])(
  'rejects unsupported query/receipt %s',
  async (path) => {
    expect((await handleAccountPreferencesHttp(request(path), deps()))?.status).toBe(400)
  }
)
it('method and unrelated namespace do not touch D1', async () => {
  const d = {
    ...deps(),
    database: {
      prepare() {
        throw new Error('unexpected_db')
      }
    } as unknown as D1Database
  }
  const r = await handleAccountPreferencesHttp(request('', 'DELETE'), d)
  expect(r?.status).toBe(405)
  expect(r?.headers.get('allow')).toBe('GET, PUT')
  expect((await handleAccountPreferencesHttp(request('/commands/' + KEY, 'POST'), d))?.headers.get('allow')).toBe('GET')
  expect(await handleAccountPreferencesHttp(new Request(origin + '/api/account/newsletter/preferences'), d)).toBeNull()
})
it.each([
  { ...INPUT, preferences: { ...INPUT.preferences, newsletter: true } },
  { ...INPUT, expectedVersion: 1.2 },
  { ...INPUT, policyVersion: 'other' },
  { ...INPUT, channel: 'sms' }
])('rejects invalid generic consent body', async (body) => {
  expect((await handleAccountPreferencesHttp(request('', 'PUT', body), deps()))?.status).toBe(400)
})
it('bounds body bytes and fails closed on edge/identity quota without ledger mutation', async () => {
  expect((await handleAccountPreferencesHttp(request('', 'PUT', { x: 'x'.repeat(3000) }), deps()))?.status).toBe(413)
  expect(
    (
      await handleAccountPreferencesHttp(request(), {
        ...deps(),
        edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
      })
    )?.status
  ).toBe(429)
  const invalid = request()
  invalid.headers.delete('cf-connecting-ip')
  expect((await handleAccountPreferencesHttp(invalid, deps()))?.status).toBe(503)
  f.sqlite
    .prepare('INSERT INTO identity_rate_limits VALUES(?,?,?,?,?)')
    .run(ACTOR, 'account-preferences', 60, Date.parse(NOW) / 1000, Date.parse(NOW) / 1000 + 3600)
  expect((await handleAccountPreferencesHttp(request('', 'PUT'), deps()))?.status).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 0 })
})
