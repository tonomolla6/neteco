import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleHighValueMessagesHttp } from '../../workers/communications/high-value-messages-http'
const origin = 'https://messages.neteco.test',
  config = { password: 'synthetic-message-cookie-password-over-32', maxAgeSeconds: 3600 },
  key = '11111111-1111-4111-8111-111111111111'
const input = {
  eventId: '22222222-2222-4222-8222-222222222222',
  event: 'security_alert',
  channel: 'sms',
  consentVersion: 0
}
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'password_changed',?)"
    )
    .run(input.eventId, BUYER_CLAIMS.identityId, utc())
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: config,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-message-pepper-more-than-32',
  now: () => utc(),
  pricing: { smsCostMinor: 5, dailyBudgetMinor: 5 },
  transport: 'local-fake'
})
const request = (method = 'POST', body: unknown = input) =>
  new Request(`${origin}/api/admin/customers/${CUSTOMER}/high-value-messages`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'CF-Connecting-IP': '192.0.2.8'
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  })
it('records and replays a private manual fallback', async () => {
  const r = await handleHighValueMessagesHttp(request(), deps())
  expect(r?.status).toBe(200)
  expect(r?.headers.get('cache-control')).toContain('private')
  expect(await r!.json()).toMatchObject({ status: 'fallback', fallback: 'manual' })
  expect((await handleHighValueMessagesHttp(request(), deps()))?.status).toBe(200)
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin', async (mode) => {
  const req = request()
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleHighValueMessagesHttp(req, deps()))?.status).toBe(403)
})
it('denies customer sessions and unsupported methods', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  expect((await handleHighValueMessagesHttp(request(), deps()))?.status).toBe(403)
  expect((await handleHighValueMessagesHttp(request('GET'), deps()))?.status).toBe(405)
})
it('rejects marketing events, client-controlled cost and oversized input', async () => {
  expect((await handleHighValueMessagesHttp(request('POST', { ...input, event: 'marketing' }), deps()))?.status).toBe(
    400
  )
  expect((await handleHighValueMessagesHttp(request('POST', { ...input, costMinor: 0 }), deps()))?.status).toBe(400)
  expect((await handleHighValueMessagesHttp(request('POST', { ...input, x: 'x'.repeat(9000) }), deps()))?.status).toBe(
    413
  )
})
it('rejects an event that is not a real high-value event for the customer', async () => {
  const res = await handleHighValueMessagesHttp(
    request('POST', { ...input, eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    deps()
  )
  expect(res?.status).toBe(404)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_fallback_commands').get()).toEqual({ n: 0 })
})
it('rejects delivery if the source no longer belongs to the customer at commit', async () => {
  const batch = f.database.batch.bind(f.database)
  let first = true
  f.database.batch = async (statements) => {
    if (first) {
      first = false
      f.sqlite.prepare('UPDATE identities SET customer_id=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    }
    return batch(statements)
  }
  const res = await handleHighValueMessagesHttp(request(), deps())
  expect(res?.status).toBe(404)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_fallback_commands').get()).toEqual({ n: 0 })
})
it('accepts native 32-character security event identifiers', async () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'password_changed',?)"
    )
    .run(id, BUYER_CLAIMS.identityId, utc())
  expect((await handleHighValueMessagesHttp(request('POST', { ...input, eventId: id }), deps()))?.status).toBe(200)
})
