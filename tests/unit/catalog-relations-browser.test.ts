import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { handleCatalogRelationsHttp } from '../../workers/catalog/catalog-relations-http'
import {
  catalogRelationsIntentHash,
  catalogRelationsCommandSchema,
  adminCatalogRelationsSchema,
  publicCatalogRelationsSchema
} from '../../shared/catalog-relations'
import {
  auditNativeCatalogRelationsBrowser,
  createCatalogRelationsBrowserBridge,
  CATALOG_RELATIONS_BROWSER_SCENARIOS,
  type CatalogRelationsBrowserFixture
} from '../../scripts/lib/audit-native-catalog-relations-browser'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test',
  configuration = { password: 'synthetic-relations-browser-session-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, adminCookie: string, prepared: CatalogRelationsBrowserFixture
let dispatch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>
const body = () => ({
  expectedVersion: 0,
  relations: [{ targetProductId: 2, kind: 'accessory' }],
  reason: 'Synthetic documentary relation review',
  reviewReference: 'synthetic-browser-review'
})
const path = '/api/admin/products/1/relations'
beforeEach(async () => {
  connect.mockReset().mockRejectedValue(new Error('private_remote_browser_endpoint_required'))
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
  adminCookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
  prepared = {
    sourceProductId: 1,
    sourceSlug: 'producto-1',
    targetProductId: 2,
    targetSlug: 'producto-2',
    targetName: 'Producto 2',
    customerCookie: (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!,
    cartCookie: 'neteco-cart-v2=synthetic-not-used-in-boundary',
    supportRef: 'SOP-' + 'A'.repeat(24)
  }
  dispatch = vi.fn(
    async (request) =>
      (await handleCatalogRelationsHttp(request, {
        database: fixture.database,
        origin,
        sessionCookieConfiguration: configuration,
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: 'synthetic-relations-browser-edge-pepper-over32'
      })) ?? new Response(null, { status: 404 })
  )
})
afterEach(() => fixture?.sqlite.close())
const bridge = () =>
  createCatalogRelationsBrowserBridge({ database: fixture.database, dispatch, origin, adminCookie, fixture: prepared })
const request = (
  url = path + '/commands',
  method = 'POST',
  value: unknown = body(),
  key = randomUUID(),
  hash?: string,
  cookie = adminCookie
) =>
  new Request(origin + url, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'CF-Connecting-IP': '192.0.2.198',
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(value) })
  })
it('NOTRUN keeps two pending journeys and performs zero prepare SQL dispatch or browser connection', async () => {
  const prepare = vi.fn(),
    sql = vi.fn(),
    scenario = vi.fn()
  const result = await auditNativeCatalogRelationsBrowser({
    database: { prepare: sql } as never,
    dispatch,
    origin,
    adminCookie,
    prepare,
    scenario,
    browserMode: 'not-run'
  })
  expect(result).toMatchObject({ scenarios: 0, browserExecuted: false, productionBrowserAcceptance: false })
  expect(CATALOG_RELATIONS_BROWSER_SCENARIOS).toHaveLength(2)
  for (const spy of [prepare, sql, dispatch, connect, scenario]) expect(spy).not.toHaveBeenCalled()
})
it('required rejects missing private endpoint before fixtures or database reads', async () => {
  const prepare = vi.fn(),
    sql = vi.fn()
  await expect(
    auditNativeCatalogRelationsBrowser({
      database: { prepare: sql } as never,
      dispatch,
      origin,
      adminCookie,
      prepare,
      browserMode: 'required'
    })
  ).rejects.toThrow('private_remote_browser_endpoint_required')
  for (const spy of [prepare, sql, dispatch]) expect(spy).not.toHaveBeenCalled()
})
it('loses a real201 only after immutable D1 proof then recovers exact receipt and fresh private snapshot', async () => {
  const transport = bridge(),
    key = randomUUID()
  expect(await transport.forward(request(undefined, undefined, undefined, key))).toMatchObject({
    action: 'abort',
    reason: 'proven_catalog_relations_response_lost'
  })
  expect(
    fixture.sqlite.prepare('SELECT count(*) n FROM catalog_relation_commands WHERE command_id=?').get(key)?.n
  ).toBe(1)
  const recovery = await transport.forward(
    request(path + '/commands/' + key, 'GET', undefined, key, await catalogRelationsIntentHash(1, body()))
  )
  expect(recovery.action).toBe('fulfill')
  if (recovery.action !== 'fulfill') throw new Error('expected_real_recovery')
  expect(catalogRelationsCommandSchema.parse(await recovery.response.json())).toMatchObject({
    outcome: 'applied',
    receipt: { commandId: key, version: 1 }
  })
  const fresh = await transport.forward(request(path, 'GET'))
  expect(fresh.action).toBe('fulfill')
  if (fresh.action !== 'fulfill') throw new Error('expected_real_snapshot')
  expect(adminCatalogRelationsSchema.parse(await fresh.response.json()).items).toEqual(body().relations)
  expect(dispatch.mock.calls.filter(([value]) => value.method === 'POST')).toHaveLength(1)
})
it('rejects an automatic or manual repost before dispatch after the injected loss', async () => {
  const transport = bridge(),
    key = randomUUID()
  await transport.forward(request(undefined, undefined, undefined, key))
  const calls = dispatch.mock.calls.length
  await expect(transport.forward(request(undefined, undefined, undefined, key))).rejects.toThrow(
    /repost|second|replay/i
  )
  expect(dispatch).toHaveBeenCalledTimes(calls)
})
it('reads actual published relations without changing cart order money or stock', async () => {
  const transport = bridge()
  await transport.forward(request())
  const tables = [
    'carts',
    'cart_lines',
    'orders',
    'order_lines',
    'inventory_balances',
    'inventory_movements',
    'payment_intents'
  ]
  const snapshot = () => tables.map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()])
  const before = snapshot()
  const response = await transport.forward(
    request('/api/product-relations?slugs=producto-1', 'GET', undefined, undefined, undefined, prepared.customerCookie)
  )
  expect(response.action).toBe('fulfill')
  if (response.action !== 'fulfill') throw new Error('expected_real_public_read')
  expect(publicCatalogRelationsSchema.parse(await response.response.json()).groups[0]?.items).toEqual([
    expect.objectContaining({ productId: 2, kind: 'accessory', minPrice: 500 })
  ])
  expect(snapshot()).toEqual(before)
})
it('blocks buyer relation writes and all provider transport before dispatch', async () => {
  const transport = bridge()
  expect(
    await transport.forward(request(undefined, undefined, undefined, undefined, undefined, prepared.customerCookie))
  ).toMatchObject({ action: 'abort' })
  expect(await transport.forward(request('/api/checkout/pay'))).toMatchObject({ action: 'abort' })
  expect(await transport.forward(new Request('https://provider.example.invalid/'))).toMatchObject({ action: 'abort' })
  expect(dispatch).not.toHaveBeenCalled()
})
