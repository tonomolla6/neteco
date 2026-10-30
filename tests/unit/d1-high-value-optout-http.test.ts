import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleHighValueOptOutHttp } from '../../workers/communications/high-value-optout-http'
const origin = 'https://account.neteco.test',
  config = { password: 'synthetic-account-cookie-password-over-32', maxAgeSeconds: 3600 },
  key = '11111111-1111-4111-8111-111111111111'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: config,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-account-pepper-more-than-32',
  now: () => utc()
})
const request = (method = 'GET', body: unknown = { expectedVersion: 0 }) =>
  new Request(`${origin}/api/account/high-value-consent/sms`, {
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
it('returns private consent status and allows a repeatable opt-out', async () => {
  const before = await handleHighValueOptOutHttp(request(), deps())
  expect(before?.headers.get('cache-control')).toContain('private')
  expect(await before!.json()).toMatchObject({ granted: false, version: 0 })
  expect((await handleHighValueOptOutHttp(request('POST'), deps()))?.status).toBe(200)
  expect((await handleHighValueOptOutHttp(request('POST'), deps()))?.status).toBe(200)
  expect(await (await handleHighValueOptOutHttp(request(), deps()))!.json()).toMatchObject({
    granted: false,
    version: 1
  })
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleHighValueOptOutHttp(req, deps()))?.status).toBe(403)
})
it('rejects unsigned requests and method abuse', async () => {
  cookie = ''
  expect((await handleHighValueOptOutHttp(request(), deps()))?.status).toBe(401)
  expect((await handleHighValueOptOutHttp(request('DELETE'), deps()))?.status).toBe(405)
})
it('rejects customer selection, grant attempts, and large bodies', async () => {
  expect(
    (await handleHighValueOptOutHttp(request('POST', { expectedVersion: 0, customerId: 'other' }), deps()))?.status
  ).toBe(400)
  expect(
    (await handleHighValueOptOutHttp(request('POST', { expectedVersion: 0, action: 'grant' }), deps()))?.status
  ).toBe(400)
  expect((await handleHighValueOptOutHttp(request('POST', { x: 'x'.repeat(9000) }), deps()))?.status).toBe(413)
})
