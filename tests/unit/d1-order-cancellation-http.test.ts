import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleOrderCancellationHttp } from '../../workers/catalog/order-cancellation-http'
import { orderCancellationReceiptSchema, orderCancellationCommandSchema } from '../../shared/order-cancellation'
import { deterministicTestData } from '../fixtures/deterministic'
const data = deterministicTestData('cancellation-http', '2026-10-08T12:00:00Z')
const origin = 'https://cancellation.neteco.test',
  configuration = { password: 'synthetic-cancellation-cookie-password-32', maxAgeSeconds: 3600 }
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, customerCookie: string, adminCookie: string
const key = data.uuid(),
  body = { expectedStatus: 'awaiting_payment', reason: 'Explicit cancellation requested by the buyer.' }
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  f = await returnsFixture()
  f.sqlite.function('cancellation_test_clock', () => utc())
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'cancellation_test_clock()'))
  orderId = await f.order({ paid: false, delivered: false })
  customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: configuration,
  origin,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-cancellation-pepper-over-32',
  now: () => utc()
})
function request(method = 'GET', audience: 'customer' | 'admin' = 'customer', suffix = '', input: unknown = body) {
  return new Request(`${origin}/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}/cancellation${suffix}`, {
    method,
    headers: {
      Cookie: audience === 'admin' ? adminCookie : customerCookie,
      'CF-Connecting-IP': '192.0.2.99',
      Origin: origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': key
    },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {})
  })
}
describe('private unpaid order cancellation HTTP', () => {
  it.each(['customer', 'admin'] as const)(
    'offers and executes %s cancellation, then reads its receipt without writes',
    async (audience) => {
      const before = f.sqlite.prepare('SELECT total_changes() n').get()
      const eligible = await handleOrderCancellationHttp(request('GET', audience), deps())
      expect(eligible?.status).toBe(200)
      expect(await eligible!.json()).toMatchObject({ eligible: true, blocker: null })
      expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
      const cancelled = await handleOrderCancellationHttp(request('POST', audience), deps())
      expect(cancelled?.status).toBe(200)
      const receipt = orderCancellationReceiptSchema.parse(await cancelled!.json())
      const command = f.sqlite.prepare('SELECT response_body FROM payment_commands WHERE command_id=?').get(key) as {
        response_body: string
      }
      const context = JSON.parse(command.response_body).auditContext
      const actor = audience === 'admin' ? CLAIMS : BUYER_CLAIMS
      expect(context).toEqual({
        audience,
        sessionId: actor.sessionId,
        sessionVersion: actor.sessionVersion,
        ipHash: createHmac('sha256', deps().rateLimitPepper)
          .update('neteco:admin-audit:request-ip:v1:192.0.2.99')
          .digest('hex')
      })
      const after = f.sqlite.prepare('SELECT total_changes() n').get()
      const recovered = await handleOrderCancellationHttp(request('GET', audience, `/commands/${key}`), deps())
      expect(recovered?.status).toBe(200)
      expect(orderCancellationCommandSchema.parse(await recovered!.json())).toEqual(receipt)
      expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(after)
      expect(recovered!.headers.get('cache-control')).toBe('private, no-store')
      expect(recovered!.headers.get('vary')).toBe('Cookie')
      expect(recovered!.headers.get('set-cookie')).toBeNull()
    }
  )
  it('returns unknown without claiming no commit', async () => {
    const response = await handleOrderCancellationHttp(request('GET', 'customer', `/commands/${key}`), deps())
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ source: 'cloudflare', orderId, commandId: key, outcome: 'unknown' })
  })
  it.each([
    ['DELETE', '', 'GET, POST'],
    ['POST', `/commands/${key}`, 'GET']
  ] as const)('rejects %s on %s before auth or DB', async (method, suffix, allow) => {
    const prepare = vi.spyOn(f.database, 'prepare')
    const response = await handleOrderCancellationHttp(request(method, 'customer', suffix), deps())
    expect(response?.status).toBe(405)
    expect(response!.headers.get('allow')).toBe(allow)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('rejects cross-site and missing Origin writes without financial effects', async () => {
    for (const value of ['https://foreign.invalid', null]) {
      const req = request('POST')
      if (value) req.headers.set('origin', value)
      else req.headers.delete('origin')
      expect((await handleOrderCancellationHttp(req, deps()))?.status).toBe(403)
    }
    expect(f.sqlite.prepare('SELECT status FROM orders').get()).toEqual({ status: 'awaiting_payment' })
  })
  it('requires current customer cookie and admin permission/MFA', async () => {
    const missing = request()
    missing.headers.delete('cookie')
    expect((await handleOrderCancellationHttp(missing, deps()))?.status).toBe(401)
    const denied = request('POST', 'admin')
    denied.headers.set('cookie', customerCookie)
    expect((await handleOrderCancellationHttp(denied, deps()))?.status).toBe(403)
    f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    expect((await handleOrderCancellationHttp(request('POST', 'admin'), deps()))?.status).toBe(403)
  })
  it.each([
    { expectedStatus: 'paid', reason: body.reason },
    { ...body, extra: 'reject' },
    { ...body, reason: 'short' }
  ])('rejects invalid command input %j', async (input) => {
    expect((await handleOrderCancellationHttp(request('POST', 'customer', '', input), deps()))?.status).toBe(400)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_commands').get()).toEqual({ n: 0 })
  })
  it('bounds body, keys and queries and ignores unrelated routes', async () => {
    expect(await handleOrderCancellationHttp(new Request(origin + '/api/products'), deps())).toBeNull()
    expect((await handleOrderCancellationHttp(request('GET', 'customer', '?now=2099'), deps()))?.status).toBe(400)
    const invalid = request('POST')
    invalid.headers.set('idempotency-key', 'not-uuid')
    expect((await handleOrderCancellationHttp(invalid, deps()))?.status).toBe(400)
    expect(
      (
        await handleOrderCancellationHttp(
          request('POST', 'customer', '', { ...body, reason: 'x'.repeat(5000) }),
          deps()
        )
      )?.status
    ).toBe(413)
  })
  it('fails closed for edge denial, outage and corrupt receipt without exposing internals', async () => {
    expect(
      (
        await handleOrderCancellationHttp(request(), {
          ...deps(),
          edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
        })
      )?.status
    ).toBe(429)
    const outage = await handleOrderCancellationHttp(request(), {
      ...deps(),
      edgeLimiter: {
        limit: async () => {
          throw new Error('private')
        }
      } as unknown as RateLimit
    })
    expect(outage?.status).toBe(503)
    expect(await outage!.json()).toEqual({ error: { code: 'unavailable' } })
    await handleOrderCancellationHttp(request('POST'), deps())
    f.sqlite.prepare('UPDATE payment_commands SET response_body=? WHERE command_id=?').run('{"secret":"never"}', key)
    const corrupt = await handleOrderCancellationHttp(request('GET', 'customer', `/commands/${key}`), deps())
    expect(corrupt?.status).toBe(503)
    expect(await corrupt!.json()).toEqual({ error: { code: 'unavailable' } })
  })
})
