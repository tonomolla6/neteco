import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import {
  deliveryPreferencesFixture,
  CLAIMS,
  KEY,
  OPTIONS,
  NOW,
  ACTOR,
  SESSION
} from './d1-delivery-preferences-fixture'
import {
  handleDeliveryPreferencesRequest,
  ownsDeliveryPreferencesNamespace
} from '../../workers/auth/delivery-preferences-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  deliveryPreferenceIntentHash
} from '../../shared/delivery-preferences'
let f: Awaited<ReturnType<typeof deliveryPreferencesFixture>>, cookie: string
const origin = 'https://preferences.neteco.test',
  configuration = { password: 'synthetic-delivery-cookie-password-over32', maxAgeSeconds: 3600 }
const INPUT = { expectedVersion: 0, deliveryUpdates: false, policyVersion: POLICY }
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  f = await deliveryPreferencesFixture()
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f?.sqlite.close()
  vi.useRealTimers()
})
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: configuration,
  origin,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-delivery-edge-pepper-over32',
  now: OPTIONS.now
})
const request = (path = '', method = 'GET', body: unknown = INPUT) =>
  new Request(origin + '/api/account/delivery-preferences' + path, {
    method,
    headers: {
      cookie,
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.70',
      'Content-Type': 'application/json',
      'Idempotency-Key': KEY
    },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {})
  })
it('completes signed-cookie opt-out/replay/hash receipt and readonly current state', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await (await handleDeliveryPreferencesRequest(request(), deps()))!.json()).toMatchObject({
    version: 0,
    deliveryUpdates: true
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  const first = await handleDeliveryPreferencesRequest(request('', 'PUT'), deps())
  expect(first!.status).toBe(200)
  const receipt = await first!.json()
  expect(await (await handleDeliveryPreferencesRequest(request('', 'PUT'), deps()))!.json()).toEqual(receipt)
  const saved = f.sqlite.prepare('SELECT total_changes() n').get(),
    r = request('/commands/' + KEY)
  r.headers.set('X-Neteco-Command-Payload-Hash', await deliveryPreferenceIntentHash(INPUT))
  const recovered = await handleDeliveryPreferencesRequest(r, deps())
  expect(await recovered!.json()).toMatchObject({ outcome: 'applied', receipt })
  expect(recovered!.headers.get('cache-control')).toBe('private, no-store')
  expect(recovered!.headers.get('vary')).toBe('Cookie')
  expect(recovered!.headers.has('set-cookie')).toBe(false)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(saved)
  r.headers.set('X-Neteco-Command-Payload-Hash', '0'.repeat(64))
  expect((await handleDeliveryPreferencesRequest(r, deps()))!.status).toBe(409)
})
it.each(['missing-origin', 'foreign-origin', 'foreign-url', 'cross-site'])(
  'rejects %s before cookie/D1 writes',
  async (kind) => {
    let r = request('', 'PUT')
    if (kind === 'missing-origin') r.headers.delete('origin')
    if (kind === 'foreign-origin') r.headers.set('origin', 'https://foreign.invalid')
    if (kind === 'foreign-url')
      r = new Request('https://foreign.invalid/api/account/delivery-preferences', {
        method: 'PUT',
        headers: r.headers,
        body: JSON.stringify(INPUT)
      })
    if (kind === 'cross-site') r.headers.set('sec-fetch-site', 'cross-site')
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    expect((await handleDeliveryPreferencesRequest(r, deps()))!.status).toBe(403)
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  }
)
it.each(['anonymous', 'revoked', 'email'])('rejects %s before quota/write', async (kind) => {
  const r = request('', 'PUT')
  if (kind === 'anonymous') r.headers.delete('cookie')
  if (kind === 'revoked') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
  if (kind === 'email') f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ACTOR)
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect((await handleDeliveryPreferencesRequest(r, deps()))!.status).toBe(kind === 'email' ? 403 : 401)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('enforces edge before cookie/D1 and identity quota before commands', async () => {
  expect(
    (await handleDeliveryPreferencesRequest(request(), {
      ...deps(),
      edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit,
      database: {
        prepare: () => {
          throw new Error('unexpected_db')
        }
      } as unknown as D1Database
    }))!.status
  ).toBe(429)
  const invalid = request()
  invalid.headers.delete('CF-Connecting-IP')
  expect((await handleDeliveryPreferencesRequest(invalid, deps()))!.status).toBe(503)
  f.sqlite
    .prepare('INSERT INTO identity_rate_limits VALUES(?,?,?,?,?)')
    .run(ACTOR, 'account-preferences', 60, Date.parse(NOW) / 1000, Date.parse(NOW) / 1000 + 3600)
  expect((await handleDeliveryPreferencesRequest(request('', 'PUT'), deps()))!.status).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM delivery_preference_commands').get()).toEqual({ n: 0 })
})
it.each(['?q=x', '?x=a&x=b', '/commands/bad', '/commands/' + KEY + '?x=1'])(
  'rejects unsupported URL %s',
  async (path) => {
    expect((await handleDeliveryPreferencesRequest(request(path), deps()))!.status).toBe(400)
  }
)
it('requires exact receipt hash and owns encoded aliases without dispatching them', async () => {
  expect((await handleDeliveryPreferencesRequest(request('/commands/' + KEY), deps()))!.status).toBe(400)
  for (const path of ['/api/account/DELIVERY-PREFERENCES', '/api/account/delivery-preferences%2fcommands%2fbad']) {
    expect(ownsDeliveryPreferencesNamespace(path)).toBe(true)
    expect((await handleDeliveryPreferencesRequest(new Request(origin + path), deps()))!.status).toBe(400)
  }
})
it('keeps unrelated routes and unsupported methods away from D1', async () => {
  const d = {
    ...deps(),
    database: {
      prepare: () => {
        throw new Error('unexpected_db')
      }
    } as unknown as D1Database
  }
  expect(await handleDeliveryPreferencesRequest(new Request(origin + '/api/account/preferences'), d)).toBeNull()
  const r = await handleDeliveryPreferencesRequest(request('', 'DELETE'), d)
  expect(r!.status).toBe(405)
  expect(r!.headers.get('allow')).toBe('GET, PUT')
  expect((await handleDeliveryPreferencesRequest(request('/commands/' + KEY, 'POST'), d))!.headers.get('allow')).toBe(
    'GET'
  )
})
it('returns not_found for an unknown canonical subroute without touching D1', async () => {
  const d = {
    ...deps(),
    database: {
      prepare: () => {
        throw new Error('unexpected_db')
      }
    } as unknown as D1Database
  }
  const response = await handleDeliveryPreferencesRequest(request('/not-a-route'), d)
  expect(response!.status).toBe(404)
  expect(await response!.json()).toEqual({ error: { code: 'not_found' } })
})
it('bounds streamed bytes, malformed JSON and unsupported consent fields', async () => {
  expect((await handleDeliveryPreferencesRequest(request('', 'PUT', { x: 'x'.repeat(3000) }), deps()))!.status).toBe(
    413
  )
  for (const body of [
    { ...INPUT, deliveryUpdates: 'yes' },
    { ...INPUT, newsletter: true },
    { ...INPUT, policyVersion: 'other' },
    { ...INPUT, channel: 'sms' }
  ])
    expect((await handleDeliveryPreferencesRequest(request('', 'PUT', body), deps()))!.status).toBe(400)
  const r = request('', 'PUT')
  r.headers.set('content-length', 'invalid')
  expect((await handleDeliveryPreferencesRequest(r, deps()))!.status).toBe(413)
})
