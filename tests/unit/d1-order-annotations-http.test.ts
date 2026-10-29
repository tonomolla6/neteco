import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleOrderAnnotationsHttp } from '../../workers/catalog/order-annotations-http'
const origin = 'https://annotations.neteco.test',
  configuration = { password: 'synthetic-annotations-cookie-password-32', maxAgeSeconds: 3600 },
  key = '11111111-1111-4111-8111-111111111111'
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0063_order_annotations.sql', 'utf8'))
  orderId = await f.order({ paid: false, delivered: false })
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: configuration,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-annotations-pepper-more-than32',
  now: () => utc()
})
const request = (method = 'GET', suffix = '', body: unknown = { expectedVersion: 0, note: 'Privada' }) =>
  new Request(`${origin}/api/admin/orders/${orderId}/annotations${suffix}`, {
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
it('keeps GET and receipt recovery read-only, private, no-store', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  const first = await handleOrderAnnotationsHttp(request(), deps())
  expect(first?.status).toBe(200)
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  expect((await handleOrderAnnotationsHttp(request('POST'), deps()))?.status).toBe(200)
  const saved = f.sqlite.prepare('SELECT total_changes() n').get(),
    response = await handleOrderAnnotationsHttp(request('GET', `/commands/${key}`), deps())
  expect(await response!.json()).toMatchObject({ outcome: 'applied', receipt: { orderId, version: 1 } })
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(saved)
})
it.each(['missing', 'foreign', 'crosssite'])('blocks %s CSRF before command effects', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleOrderAnnotationsHttp(req, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 0 })
})
it('never exposes a client route or customer data access', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  expect((await handleOrderAnnotationsHttp(request(), deps()))?.status).toBe(403)
  expect(
    await handleOrderAnnotationsHttp(new Request(`${origin}/api/orders/${orderId}/annotations`), deps())
  ).toBeNull()
})
it.each(['?limit=0', '?limit=51', '?limit=2&limit=3', '?before=bad', '?extra=x'])(
  'rejects invalid query %s',
  async (suffix) => {
    expect((await handleOrderAnnotationsHttp(request('GET', suffix), deps()))?.status).toBe(400)
  }
)
it('rejects oversized stream even without Content-Length', async () => {
  expect(
    (await handleOrderAnnotationsHttp(request('POST', '', { expectedVersion: 0, note: 'x'.repeat(9000) }), deps()))
      ?.status
  ).toBe(413)
})
it('denies edge or identity quotas without an annotation write', async () => {
  const limited = { ...deps(), edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit }
  expect((await handleOrderAnnotationsHttp(request('POST'), limited))?.status).toBe(429)
  f.sqlite
    .prepare('INSERT INTO identity_rate_limits VALUES(?,?,?,?,?)')
    .run(
      CLAIMS.identityId,
      'admin-order-annotations',
      60,
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000) + 3600
    )
  expect((await handleOrderAnnotationsHttp(request('POST'), deps()))?.status).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 0 })
})
