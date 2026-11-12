import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerCartSnapshotsHttp } from '../../workers/catalog/cart-snapshots-http'
import {
  cartSnapshotIntentHash,
  cartSnapshotCommandSchema,
  cartSnapshotListSchema,
  sharedCartResolveResponseSchema
} from '../../shared/cart-snapshots'
import {
  auditNativeCartSnapshotsBrowser,
  CART_SNAPSHOTS_BROWSER_SCENARIOS,
  createCartSnapshotsBrowserBridge
} from '../../scripts/lib/audit-native-cart-snapshots-browser'
import { testUuid } from '../support/deterministic'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test'
const configuration = { password: 'synthetic-cart-snapshot-browser-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>
let prepared: {
  customerCookie: string
  cartCookie: string
  cartId: string
  cartVersion: number
  variantId: string
  variantLegacyId: number
  quantity: number
}
let dispatch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>
beforeEach(async () => {
  connect.mockReset().mockRejectedValue(new Error('private_remote_browser_endpoint_required'))
  fixture = await returnsFixture()
  for (const file of (await readdir('db/d1/migrations'))
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && Number(file.slice(0, 4)) <= 75)
    .sort())
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => fixture.database.prepare(sql))
    )
  const customerCookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  const cart = await createCart(fixture.database, { now: utc(), correlationId: 'snapshot-browser-fixture' })
  await setCartLine(fixture.database, {
    ...cart,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: testUuid(),
    now: utc(),
    correlationId: 'snapshot-browser-fixture'
  })
  prepared = {
    customerCookie,
    cartCookie: `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
    cartId: cart.cartId,
    cartVersion: 2,
    variantId: 'v-1-1',
    variantLegacyId: Number(
      fixture.sqlite.prepare('SELECT legacy_id FROM variants WHERE id=?').get('v-1-1')!.legacy_id
    ),
    quantity: 2
  }
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const commandDispatch = async (command: Record<string, unknown>) => {
    const result = await handleCartCommand(command, {
      database: fixture.database,
      getResponse: async (key) => responses.get(key),
      putResponse: async (key, value) => {
        responses.set(key, value)
      },
      setAlarm: async () => {}
    })
    return Response.json(result.body, { status: result.status })
  }
  dispatch = vi.fn(
    async (request) =>
      (await handleCustomerCartSnapshotsHttp(request, {
        database: fixture.database,
        origin,
        sessionCookieConfiguration: configuration,
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: 'synthetic-snapshot-browser-edge-pepper-over32'
      })) ??
      (await handleStorefrontCartHttp(request, {
        database: fixture.database,
        dispatch: commandDispatch,
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: 'synthetic-snapshot-browser-edge-pepper-over32'
      })) ??
      new Response(null, { status: 404 })
  )
})
afterEach(() => fixture?.sqlite.close())
const body = () => ({
  name: 'Synthetic browser saved quantities',
  expectedCartVersion: prepared.cartVersion,
  createShare: true
})
const request = (path: string, method = 'POST', value: unknown = body(), key = testUuid(), hash?: string) =>
  new Request(origin + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: `${prepared.customerCookie}; ${prepared.cartCookie}`,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.191',
      'Idempotency-Key': key,
      'X-Neteco-Cart-Id': prepared.cartId,
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(value) })
  })
const bridge = () =>
  createCartSnapshotsBrowserBridge({ origin, database: fixture.database, dispatch, fixture: prepared })
function unchanged() {
  return [
    'carts',
    'cart_lines',
    'orders',
    'order_lines',
    'payment_intents',
    'inventory_balances',
    'inventory_movements'
  ].map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])
}
it('NOTRUN is lazy and preserves two pending real Chromium journeys', async () => {
  const prepare = vi.fn(),
    sql = vi.fn(() => {
      throw new Error('unexpected_sql')
    })
  const result = await auditNativeCartSnapshotsBrowser({
    origin,
    database: { prepare: sql } as never,
    dispatch,
    prepare,
    browserMode: 'not-run'
  })
  expect(result).toMatchObject({
    scenarios: 0,
    browserExecuted: false,
    providerSubmission: false,
    productionBrowserAcceptance: false
  })
  expect(CART_SNAPSHOTS_BROWSER_SCENARIOS).toHaveLength(2)
  expect(prepare).not.toHaveBeenCalled()
  expect(sql).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})
it('required fails without a private endpoint before preparing or reading SQL', async () => {
  const prepare = vi.fn(),
    sql = vi.fn()
  await expect(
    auditNativeCartSnapshotsBrowser({
      origin,
      database: { prepare: sql } as never,
      dispatch,
      prepare,
      browserMode: 'required'
    })
  ).rejects.toThrow('private_remote_browser_endpoint_required')
  expect(prepare).not.toHaveBeenCalled()
  expect(sql).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})
it('loses only the real committed 201 and recovers the exact receipt plus fresh owner list without repost', async () => {
  const transport = bridge(),
    key = testUuid(),
    before = unchanged()
  expect(await transport.forward(request('/api/account/cart-snapshots', 'POST', body(), key))).toMatchObject({
    action: 'abort',
    reason: 'proven_cart_snapshot_response_lost'
  })
  expect(
    fixture.sqlite.prepare('SELECT count(*) n FROM customer_cart_snapshot_commands WHERE command_id=?').get(key)?.n
  ).toBe(1)
  const recovered = await transport.forward(
    request('/api/account/cart-snapshots/commands/' + key, 'GET', undefined, key, await cartSnapshotIntentHash(body()))
  )
  expect(recovered.action).toBe('fulfill')
  if (recovered.action !== 'fulfill') throw new Error('expected_real_recovery')
  expect(cartSnapshotCommandSchema.parse(await recovered.response.json())).toMatchObject({
    outcome: 'applied',
    action: 'create',
    receipt: { commandId: key, cartVersion: 2 }
  })
  const listed = await transport.forward(request('/api/account/cart-snapshots', 'GET'))
  expect(listed.action).toBe('fulfill')
  if (listed.action !== 'fulfill') throw new Error('expected_real_list')
  expect(cartSnapshotListSchema.parse(await listed.response.json()).items).toHaveLength(1)
  expect(dispatch.mock.calls.filter(([value]) => value.method === 'POST')).toHaveLength(1)
  expect(unchanged()).toEqual(before)
})
it('resolves a real capability at current public prices then owner revocation makes it uniformly unavailable', async () => {
  const transport = bridge(),
    key = testUuid(),
    before = unchanged()
  await transport.forward(request('/api/account/cart-snapshots', 'POST', body(), key))
  const recovered = await transport.forward(
    request('/api/account/cart-snapshots/commands/' + key, 'GET', undefined, key, await cartSnapshotIntentHash(body()))
  )
  expect(recovered.action).toBe('fulfill')
  if (recovered.action !== 'fulfill') throw new Error('expected_real_recovery')
  const result = cartSnapshotCommandSchema.parse(await recovered.response.json())
  if (result.outcome !== 'applied' || result.action !== 'create' || !result.share)
    throw new Error('expected_real_capability')
  const resolved = await transport.forward(
    request('/api/cart/shared/resolve', 'POST', { id: result.share.id, token: result.share.token })
  )
  expect(resolved.action).toBe('fulfill')
  if (resolved.action !== 'fulfill') throw new Error('expected_public_read')
  expect(sharedCartResolveResponseSchema.parse(await resolved.response.json()).items).toEqual([
    expect.objectContaining({ quantity: 2, unitGrossCents: 500 })
  ])
  const revoked = await transport.forward(request(`/api/account/cart-snapshots/${result.share.id}/revoke`, 'POST', {}))
  expect(revoked.action).toBe('fulfill')
  const denied = await transport.forward(
    request('/api/cart/shared/resolve', 'POST', { id: result.share.id, token: result.share.token })
  )
  expect(denied.action).toBe('fulfill')
  if (denied.action !== 'fulfill') throw new Error('expected_uniform_denial')
  expect(denied.response.status).toBe(404)
  expect(unchanged()).toEqual(before)
})
it('blocks a second create POST after response loss before dispatch', async () => {
  const transport = bridge(),
    key = testUuid()
  await transport.forward(request('/api/account/cart-snapshots', 'POST', body(), key))
  const calls = dispatch.mock.calls.length
  await expect(transport.forward(request('/api/account/cart-snapshots', 'POST', body(), key))).rejects.toThrow(
    /repost|second|replay/i
  )
  expect(dispatch).toHaveBeenCalledTimes(calls)
})
it('blocks provider and foreign transport with zero dispatch', async () => {
  const transport = bridge()
  expect(await transport.forward(request('/api/checkout/pay'))).toMatchObject({ action: 'abort' })
  expect(await transport.forward(new Request('https://outside.example.invalid/'))).toMatchObject({ action: 'abort' })
  expect(dispatch).not.toHaveBeenCalled()
})
async function resolveOriginal(transport: ReturnType<typeof bridge>) {
  const key = testUuid()
  await transport.forward(request('/api/account/cart-snapshots', 'POST', body(), key))
  const recovered = await transport.forward(
    request('/api/account/cart-snapshots/commands/' + key, 'GET', undefined, key, await cartSnapshotIntentHash(body()))
  )
  if (recovered.action !== 'fulfill') throw new Error('expected_real_recovery')
  const result = cartSnapshotCommandSchema.parse(await recovered.response.json())
  if (result.outcome !== 'applied' || result.action !== 'create' || !result.share)
    throw new Error('expected_real_capability')
  const resolved = await transport.forward(
    request('/api/cart/shared/resolve', 'POST', { id: result.share.id, token: result.share.token })
  )
  if (resolved.action !== 'fulfill' || resolved.response.status !== 200) throw new Error('expected_real_public_preview')
}
it('copies an explicitly resolved line through the real cart facade into a distinct destination without changing source or stock', async () => {
  const transport = bridge()
  await resolveOriginal(transport)
  const destination = await createCart(fixture.database, { now: utc(), correlationId: 'snapshot-browser-destination' })
  const source = fixture.sqlite
    .prepare('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id')
    .all(prepared.cartId)
  const stock = fixture.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()
  const response = await transport.forward(
    new Request(origin + '/api/cart/items', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.191',
        Cookie: `neteco-cart-v2=v1.${destination.cartId}.${destination.token}`,
        'X-Neteco-Cart-Id': destination.cartId
      },
      body: JSON.stringify({
        variantId: prepared.variantLegacyId,
        quantity: prepared.quantity,
        expectedVersion: 1,
        idempotencyKey: testUuid()
      })
    })
  )
  expect(response.action).toBe('fulfill')
  if (response.action !== 'fulfill') throw new Error('expected_real_destination_add')
  expect(response.response.status).toBe(200)
  expect(
    fixture.sqlite.prepare('SELECT variant_id,quantity FROM cart_lines WHERE cart_id=?').all(destination.cartId)
  ).toEqual([{ variant_id: prepared.variantId, quantity: prepared.quantity }])
  expect(
    fixture.sqlite.prepare('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id').all(prepared.cartId)
  ).toEqual(source)
  expect(fixture.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()).toEqual(
    stock
  )
  expect(transport.proof.adds).toBe(1)
})
it('rejects copying back into the original cart before dispatch', async () => {
  const transport = bridge()
  await resolveOriginal(transport)
  const calls = dispatch.mock.calls.length
  await expect(
    transport.forward(
      request('/api/cart/items', 'POST', {
        variantId: prepared.variantLegacyId,
        quantity: prepared.quantity,
        expectedVersion: prepared.cartVersion,
        idempotencyKey: testUuid()
      })
    )
  ).rejects.toThrow('Destination must not be the source cart')
  expect(dispatch).toHaveBeenCalledTimes(calls)
})
