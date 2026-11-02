import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleProductRecallHttp } from '../../workers/catalog/product-recall-http'
const origin = 'https://recall.neteco.test'
const config = { password: 'synthetic-recall-cookie-password-32-long', maxAgeSeconds: 3600 }
const lot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  key = '11111111-1111-4111-8111-111111111111'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  const location = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  f.sqlite
    .prepare(
      "INSERT INTO inventory_lots(id,variant_id,lot_number,location_id,status,expires_at,initial_quantity,available_quantity,version,created_at,updated_at) VALUES(?,?,'case-lot',?,'active',?,10,8,1,?,?)"
    )
    .run(lot, 'v-1-1', location, utc(86400000), utc(), utc())
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: config,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-recall-pepper-more-than-32-bytes',
  now: () => utc()
})
const request = (
  method = 'GET',
  suffix = '',
  body: unknown = { action: 'open', expectedVersion: 0, evidence: 'case-verified-123' }
) =>
  new Request(`${origin}/api/admin/product-recalls/${lot}${suffix}`, {
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
it('retrieves a recall, opens and replays a command', async () => {
  expect(await (await handleProductRecallHttp(request(), deps()))!.json()).toMatchObject({
    version: 0,
    open: false,
    affected: []
  })
  expect((await handleProductRecallHttp(request('POST'), deps()))?.status).toBe(200)
  expect((await handleProductRecallHttp(request('POST'), deps()))?.status).toBe(200)
  expect(await (await handleProductRecallHttp(request(), deps()))!.json()).toMatchObject({ version: 1, open: true })
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleProductRecallHttp(req, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT count(*) n FROM product_recall_commands').get()).toEqual({ n: 0 })
})
it('requires administrator and valid session', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  expect((await handleProductRecallHttp(request(), deps()))?.status).toBe(403)
  cookie = ''
  expect((await handleProductRecallHttp(request(), deps()))?.status).toBe(401)
})
it('rejects large bodies and extra fields', async () => {
  expect((await handleProductRecallHttp(request('POST', '', { evidence: 'x'.repeat(9000) }), deps()))?.status).toBe(413)
  expect(
    (
      await handleProductRecallHttp(
        request('POST', '', { action: 'open', expectedVersion: 0, evidence: 'case-verified-123', extra: 1 }),
        deps()
      )
    )?.status
  ).toBe(400)
})
it('rejects invalid methods and queries', async () => {
  expect((await handleProductRecallHttp(request('DELETE'), deps()))?.status).toBe(405)
  expect((await handleProductRecallHttp(request('GET', '?extra=x'), deps()))?.status).toBe(400)
})
it('validates and records a communication for a specific allocated line', async () => {
  const orderId = await f.order({ paid: false, delivered: false })
  f.sqlite
    .prepare(
      'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,NULL,1,?,?)'
    )
    .run(crypto.randomUUID(), lot, orderId, 'synthetic', utc())
  expect((await handleProductRecallHttp(request('POST'), deps()))?.status).toBe(200)
  const req = request('POST', '', {
    action: 'communicate',
    expectedVersion: 1,
    evidence: 'notice-case-123',
    orderId,
    lineIndex: 0
  })
  req.headers.set('idempotency-key', '22222222-2222-4222-8222-222222222222')
  expect((await handleProductRecallHttp(req, deps()))?.status).toBe(200)
})
it('supports bounded cursor pagination on affected lines', async () => {
  const first = await f.order({ paid: false, delivered: false }),
    second = await f.order({ paid: false, delivered: false })
  for (const id of [first, second])
    f.sqlite
      .prepare(
        'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,NULL,2,?,?)'
      )
      .run(crypto.randomUUID(), lot, id, 'synthetic', utc())
  const page = (await (await handleProductRecallHttp(request('GET', '?limit=1'), deps()))!.json()) as {
    affected: unknown[]
    nextCursor: string
  }
  expect(page.affected).toHaveLength(1)
  const next = (await (await handleProductRecallHttp(
    request('GET', `?limit=1&after=${encodeURIComponent(page.nextCursor)}`),
    deps()
  ))!.json()) as { affected: unknown[]; nextCursor: string | null }
  expect(next.affected).toHaveLength(1)
  expect(next.nextCursor).toBeNull()
  expect((await handleProductRecallHttp(request('GET', '?limit=1&limit=2'), deps()))?.status).toBe(400)
})
it('accepts an evidence-backed trace command through the authenticated endpoint', async () => {
  const orderId = await f.order({ paid: false, delivered: false })
  expect((await handleProductRecallHttp(request('POST'), deps()))?.status).toBe(200)
  const req = request('POST', '', {
    action: 'trace',
    expectedVersion: 1,
    evidence: 'trace-case-123',
    orderId,
    lineIndex: 0,
    targetLotId: lot,
    quantity: 2
  })
  req.headers.set('idempotency-key', '22222222-2222-4222-8222-222222222222')
  expect((await handleProductRecallHttp(req, deps()))?.status).toBe(200)
  expect(f.sqlite.prepare('SELECT quantity FROM inventory_lot_allocations WHERE order_id=?').get(orderId)).toEqual({
    quantity: 2
  })
})
