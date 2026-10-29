import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleHighValueConsentHttp } from '../../workers/communications/high-value-consent-http'
const origin = 'https://communications.neteco.test'
const configuration = { password: 'synthetic-communications-cookie-password-32', maxAgeSeconds: 3600 }
const key = '11111111-1111-4111-8111-111111111111'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: configuration,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-communications-pepper-more-than32',
  now: () => utc()
})
const request = (
  method = 'GET',
  suffix = '',
  body: unknown = { expectedVersion: 0, action: 'grant', proof: 'case-verified-123' }
) =>
  new Request(`${origin}/api/admin/customers/${CUSTOMER}/high-value-consent/sms${suffix}`, {
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
it('returns a private snapshot, records a consent and replays it', async () => {
  expect(await (await handleHighValueConsentHttp(request(), deps()))!.json()).toMatchObject({
    granted: false,
    version: 0
  })
  const response = await handleHighValueConsentHttp(request('POST'), deps())
  expect(response?.status).toBe(200)
  expect(response?.headers.get('cache-control')).toBe('private, no-store')
  expect(await response!.json()).toMatchObject({ version: 1, action: 'grant' })
  expect((await handleHighValueConsentHttp(request('POST'), deps()))?.status).toBe(200)
  expect(await (await handleHighValueConsentHttp(request(), deps()))!.json()).toMatchObject({
    granted: true,
    version: 1
  })
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin without writing', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleHighValueConsentHttp(req, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 0 })
})
it('denies a customer and unsigned requests', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  expect((await handleHighValueConsentHttp(request(), deps()))?.status).toBe(403)
  cookie = ''
  expect((await handleHighValueConsentHttp(request(), deps()))?.status).toBe(401)
})
it('rejects oversized input, unrecognised fields and stale versions', async () => {
  expect((await handleHighValueConsentHttp(request('POST', '', { proof: 'x'.repeat(9000) }), deps()))?.status).toBe(413)
  expect(
    (
      await handleHighValueConsentHttp(
        request('POST', '', { expectedVersion: 0, action: 'grant', proof: 'case-valid-123', channel: 'whatsapp' }),
        deps()
      )
    )?.status
  ).toBe(400)
  expect((await handleHighValueConsentHttp(request('POST'), deps()))?.status).toBe(200)
  const stale = request('POST')
  stale.headers.set('idempotency-key', '22222222-2222-4222-8222-222222222222')
  expect((await handleHighValueConsentHttp(stale, deps()))?.status).toBe(409)
})
it('denies rate-limited access and invalid methods', async () => {
  expect(
    (
      await handleHighValueConsentHttp(request(), {
        ...deps(),
        edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
      })
    )?.status
  ).toBe(429)
  expect((await handleHighValueConsentHttp(request('DELETE'), deps()))?.status).toBe(405)
})
it('rejects malformed queries and unrelated paths', async () => {
  expect((await handleHighValueConsentHttp(request('GET', '?x=1'), deps()))?.status).toBe(400)
  expect(await handleHighValueConsentHttp(new Request(`${origin}/api/unrelated`), deps())).toBeNull()
})
