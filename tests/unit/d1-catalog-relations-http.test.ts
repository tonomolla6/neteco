import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { handleCatalogRelationsHttp } from '../../workers/catalog/catalog-relations-http'
import {
  adminCatalogRelationsSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsCommandSchema,
  publicCatalogRelationsSchema,
  catalogRelationsIntentHash
} from '../../shared/catalog-relations'

const origin = 'https://catalog-relations-http.neteco.test',
  root = '/api/admin/products/1/relations'
const configuration = { password: 'synthetic-relations-session-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, cookie: string, buyer: string, key: string
let edge: { limit: () => Promise<{ success: boolean }> }
const input = () => ({
  expectedVersion: 0,
  relations: [{ targetProductId: 2, kind: 'accessory' }],
  reason: 'Synthetic documented editorial review',
  reviewReference: 'synthetic-review-001'
})
beforeEach(async () => {
  fixture = await returnsFixture()
  for (const file of (await readdir('db/d1/migrations'))
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && Number(file.slice(0, 4)) <= 76)
    .sort())
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => fixture.database.prepare(sql))
    )
  fixture.sqlite.exec(
    "INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
  )
  await provisionPublicationValidityFixture(fixture.database, { productIds: ['p-2'], now: utc(-3600000) })
  cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
  buyer = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  key = randomUUID()
  edge = { limit: async () => ({ success: true }) }
})
afterEach(() => fixture?.sqlite.close())
async function call(
  path = root,
  method = 'GET',
  value: unknown = input(),
  headers: Record<string, string> = {},
  raw?: BodyInit,
  database = fixture.database
) {
  return (await handleCatalogRelationsHttp(
    new Request(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'CF-Connecting-IP': '192.0.2.196',
        ...headers
      },
      ...(method === 'GET'
        ? {}
        : { body: raw ?? JSON.stringify(value), ...(raw instanceof ReadableStream ? { duplex: 'half' } : {}) })
    }),
    {
      database,
      origin,
      sessionCookieConfiguration: configuration,
      edgeLimiter: edge,
      rateLimitPepper: 'synthetic-relations-edge-pepper-over32'
    }
  ))!
}
function economicState() {
  return [
    'carts',
    'cart_lines',
    'orders',
    'order_lines',
    'inventory_balances',
    'inventory_movements',
    'payment_intents'
  ].map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()])
}
it('reads a genuine empty versioned admin snapshot with private no-store headers', async () => {
  const response = await call()
  expect(response.status).toBe(200)
  expect(adminCatalogRelationsSchema.parse(await response.json())).toEqual({
    source: 'cloudflare',
    productId: 1,
    version: 0,
    items: [],
    updatedAt: null
  })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
})
it('writes one directed snapshot, replays exact receipt and manually recovers without economic effects', async () => {
  const before = economicState(),
    created = await call(root + '/commands', 'POST')
  expect(created.status).toBe(201)
  const receipt = catalogRelationsReceiptSchema.parse(await created.json())
  expect(receipt).toMatchObject({
    commandId: key,
    productId: 1,
    expectedVersion: 0,
    version: 1,
    payloadHash: await catalogRelationsIntentHash(1, input())
  })
  expect(await (await call(root + '/commands', 'POST')).json()).toEqual(receipt)
  const recovered = await call(root + '/commands/' + key, 'GET', undefined, {
    'X-Neteco-Command-Payload-Hash': receipt.payloadHash
  })
  expect(recovered.status).toBe(200)
  expect(catalogRelationsCommandSchema.parse(await recovered.json())).toEqual({
    source: 'cloudflare',
    outcome: 'applied',
    receipt
  })
  expect(adminCatalogRelationsSchema.parse(await (await call()).json()).items).toEqual(input().relations)
  expect(economicState()).toEqual(before)
  expect((await call(root + '/commands', 'POST', { ...input(), reason: 'Different reviewed command' })).status).toBe(
    409
  )
})
it.each(['anonymous', 'customer', 'mfa', 'revoked'])(
  'denies unauthorized admin reads and writes: %s',
  async (boundary) => {
    let Cookie = cookie
    if (boundary === 'anonymous') Cookie = ''
    if (boundary === 'customer') Cookie = buyer
    if (boundary === 'mfa')
      fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    if (boundary === 'revoked')
      fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    const expected = ['anonymous', 'revoked'].includes(boundary) ? 401 : 403
    expect((await call(root, 'GET', undefined, { Cookie })).status).toBe(expected)
    expect((await call(root + '/commands', 'POST', input(), { Cookie })).status).toBe(expected)
  }
)
it('publishes only live validated endpoints and hides a target withdrawn after the relation was saved', async () => {
  expect((await call(root + '/commands', 'POST')).status).toBe(201)
  const path = '/api/product-relations?slugs=producto-1'
  const response = await call(path, 'GET', undefined, { Cookie: '' })
  expect(response.status).toBe(200)
  const result = publicCatalogRelationsSchema.parse(await response.json())
  expect(result.groups[0]?.items).toEqual([
    expect.objectContaining({ kind: 'accessory', productId: 2, slug: 'producto-2', minPrice: 500 })
  ])
  fixture.sqlite.prepare("UPDATE products SET status='draft' WHERE id='p-2'").run()
  expect(
    publicCatalogRelationsSchema
      .parse(await (await call(path, 'GET', undefined, { Cookie: '' })).json())
      .groups.flatMap((group) => group.items)
  ).toEqual([])
})
it('rejects malformed, oversized and non-UTF8 command bodies before any relation is written', async () => {
  expect(
    (await call(root + '/commands', 'POST', { ...input(), relations: [{ targetProductId: 1, kind: 'compatible' }] }))
      .status
  ).toBe(400)
  expect(
    (await call(root + '/commands', 'POST', { ...input(), relations: [...input().relations, ...input().relations] }))
      .status
  ).toBe(400)
  expect((await call(root + '/commands', 'POST', input(), {}, new Uint8Array([255]))).status).toBe(400)
  expect((await call(root + '/commands', 'POST', input(), {}, ' '.repeat(32769))).status).toBe(413)
  expect((await call(root + '/commands', 'POST', input(), { 'Content-Type': 'text/plain' })).status).toBe(415)
})
it('enforces CSRF, empty admin query and explicit supported verbs', async () => {
  expect((await call(root + '/commands', 'POST', input(), { Origin: 'https://outside.example.invalid' })).status).toBe(
    403
  )
  expect((await call(root + '?token=private')).status).toBe(400)
  expect((await call(root, 'DELETE')).status).toBe(405)
  expect((await call(root + '/commands', 'GET')).status).toBe(405)
})
it('bounds and validates literal public slug batches without requiring a customer cookie', async () => {
  for (const query of [
    '',
    'slugs=producto-1&slugs=producto-2',
    'slugs=producto-1,producto-1',
    'slugs=../private',
    'slugs=' + Array.from({ length: 21 }, (_, i) => `producto-${i}`).join(',')
  ])
    expect((await call('/api/product-relations?' + query, 'GET', undefined, { Cookie: '' })).status).toBe(400)
})
it('revalidates live authority after streamed body delivery instead of releasing a stale authorization', async () => {
  const raw = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input())))
        controller.close()
      }
    },
    { highWaterMark: 0 }
  )
  expect((await call(root + '/commands', 'POST', input(), {}, raw)).status).toBe(401)
})
it('fails closed on D1 and edge outages without returning a fabricated empty result', async () => {
  edge.limit = async () => ({ success: false })
  expect((await call()).status).toBe(429)
  edge.limit = async () => ({ success: true })
  const response = await call(root, 'GET', undefined, {}, undefined, {
    prepare() {
      throw new Error('private_sql_failure')
    }
  } as unknown as D1Database)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
})
