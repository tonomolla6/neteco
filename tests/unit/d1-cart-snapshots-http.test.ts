import { readFile, readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  cartSnapshotResponseSchema,
  cartSnapshotIntentHash,
  sharedCartResolveResponseSchema
} from '../../shared/cart-snapshots'
import { handleCustomerCartSnapshotsHttp } from '../../workers/catalog/cart-snapshots-http'
import { testUuid } from '../support/deterministic'

const origin = 'https://cart-snapshots-http.neteco.test'
const root = '/api/account/cart-snapshots'
const configuration = { password: 'synthetic-cart-snapshot-session-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, sessionCookie: string, cartCookie: string
let cart: Awaited<ReturnType<typeof createCart>>
let edge: { limit: () => Promise<{ success: boolean }> }
const input = () => ({ name: 'Synthetic saved cart', expectedCartVersion: 2, createShare: true })
it.each(['/api/account/cart-snapshots', '/API/ACCOUNT/CART-SNAPSHOTS', '/api/cart/%73hared/resolve'])(
  'actual canary consumes %s with AUTH off before any D1 access',
  async (path) => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_database_access')
    })
    const response = await worker.fetch(
      new Request(origin + path),
      { AUTH_ENABLED: 'false', DB: { prepare } } as never,
      {} as ExecutionContext
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(prepare).not.toHaveBeenCalled()
  }
)
beforeEach(async () => {
  fixture = await returnsFixture()
  for (const file of (await readdir('db/d1/migrations'))
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && Number(file.slice(0, 4)) <= 75)
    .sort()) {
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => fixture.database.prepare(sql))
    )
  }
  sessionCookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  cart = await createCart(fixture.database, { now: utc(), correlationId: 'snapshot-http-fixture' })
  await setCartLine(fixture.database, {
    ...cart,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: testUuid(),
    now: utc(),
    correlationId: 'snapshot-http-fixture'
  })
  cartCookie = `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
  edge = { limit: async () => ({ success: true }) }
})
afterEach(() => fixture?.sqlite.close())
async function call(
  path = root,
  {
    method = 'POST',
    value = input(),
    headers = {},
    raw,
    database = fixture.database
  }: {
    method?: string
    value?: unknown
    headers?: Record<string, string>
    raw?: BodyInit
    database?: D1Database
  } = {}
) {
  return (await handleCustomerCartSnapshotsHttp(
    new Request(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: `${sessionCookie}; ${cartCookie}`,
        'X-Neteco-Cart-Id': cart.cartId,
        'CF-Connecting-IP': '192.0.2.188',
        'Content-Type': 'application/json',
        'Idempotency-Key': commandKey,
        ...headers
      },
      ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(value) })
    }),
    {
      database,
      origin,
      sessionCookieConfiguration: configuration,
      edgeLimiter: edge,
      rateLimitPepper: 'synthetic-snapshot-edge-pepper-more-than32'
    }
  ))!
}
let commandKey: string
beforeEach(() => {
  commandKey = testUuid()
})
function cartState() {
  return [
    'carts',
    'cart_lines',
    'checkout_quotes',
    'shipping_quotes',
    'orders',
    'inventory_balances',
    'inventory_movements'
  ].map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()])
}
it('rejects a frozen cart A header with cart B credentials before creating any list or receipt', async () => {
  const replacement = await createCart(fixture.database, { now: utc(), correlationId: 'snapshot-replacement-cart' })
  await setCartLine(fixture.database, {
    ...replacement,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: testUuid(),
    now: utc(),
    correlationId: 'snapshot-replacement-cart'
  })
  const before = ['customer_favorite_lists', 'customer_favorite_items', 'customer_cart_snapshot_commands'].map(
    (table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()]
  )
  const response = await call(root, {
    headers: { Cookie: `${sessionCookie}; neteco-cart-v2=v1.${replacement.cartId}.${replacement.token}` }
  })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
  expect(
    ['customer_favorite_lists', 'customer_favorite_items', 'customer_cart_snapshot_commands'].map((table) => [
      table,
      fixture.sqlite.prepare('SELECT * FROM ' + table).all()
    ])
  ).toEqual(before)
})
it('creates a new real favorite list from server quantities and a private share without mutating the source cart', async () => {
  const before = cartState(),
    count = fixture.sqlite.prepare('SELECT count(*) n FROM customer_favorite_lists').get()?.n
  const response = await call()
  expect(response.status).toBe(201)
  const result = cartSnapshotResponseSchema.parse(await response.json())
  expect(result.receipt).toMatchObject({ commandId: commandKey, cartVersion: 2 })
  expect(result.share?.token).not.toBe(cart.token)
  expect(result.share?.id).toBe(result.receipt.shareId)
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM customer_favorite_lists').get()?.n).toBe(Number(count) + 1)
  expect(
    fixture.sqlite
      .prepare('SELECT variant_id,quantity FROM customer_favorite_items WHERE list_id=?')
      .all(result.receipt.listId)
  ).toEqual([{ variant_id: 'v-1-1', quantity: 2 }])
  expect(cartState()).toEqual(before)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('set-cookie')).toBeNull()
})
it('saves without sharing when explicitly requested and lists receipts without tokens', async () => {
  const response = await call(root, { value: { ...input(), createShare: false } })
  expect(response.status).toBe(201)
  expect(cartSnapshotResponseSchema.parse(await response.json()).share).toBeNull()
  const listed = await call(root, { method: 'GET', headers: { Cookie: sessionCookie } })
  expect(listed.status).toBe(200)
  const text = await listed.text()
  expect(JSON.parse(text).items).toHaveLength(1)
  expect(text).not.toContain(cart.token)
  expect(text).not.toContain('"token"')
})
it('replays the exact command and recovers its original capability only with both original credentials', async () => {
  const first = await call()
  expect(first.status).toBe(201)
  const expected = await first.json()
  const replay = await call()
  expect(replay.status).toBe(201)
  expect(await replay.json()).toEqual(expected)
  const hash = await cartSnapshotIntentHash(input())
  const recovered = await call(root + '/commands/' + commandKey, {
    method: 'GET',
    headers: { 'X-Neteco-Command-Payload-Hash': hash }
  })
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({
    action: 'create',
    outcome: 'applied',
    receipt: expected.receipt,
    share: expected.share
  })
  expect(
    (
      await call(root + '/commands/' + commandKey, {
        method: 'GET',
        headers: { Cookie: sessionCookie, 'X-Neteco-Command-Payload-Hash': hash }
      })
    ).status
  ).toBe(401)
  expect((await call(root, { value: { ...input(), name: 'Different intent' } })).status).toBe(409)
})
it('resolves current public prices with no cookie and performs no writes to the original cart', async () => {
  const created = await call()
  expect(created.status).toBe(201)
  const share = cartSnapshotResponseSchema.parse(await created.json()).share!
  const before = cartState()
  const response = await call('/api/cart/shared/resolve', {
    value: { id: share.id, token: share.token },
    headers: { Cookie: '' }
  })
  expect(response.status).toBe(200)
  const resolved = sharedCartResolveResponseSchema.parse(await response.json())
  expect(resolved.items).toEqual([
    expect.objectContaining({ variantId: 'v-1-1', quantity: 2, available: true, unitGrossCents: 500 })
  ])
  expect(cartState()).toEqual(before)
  expect(JSON.stringify(resolved)).not.toMatch(/buyer@example|Synthetic saved cart|costNet|customerId|coupon/)
  expect(
    (await call('/api/cart/shared/resolve', { value: { id: share.id, token: cart.token }, headers: { Cookie: '' } }))
      .status
  ).toBe(404)
})
it('revokes monotonically by owner session alone and makes public resolution uniformly unavailable', async () => {
  const created = await call()
  expect(created.status).toBe(201)
  const share = cartSnapshotResponseSchema.parse(await created.json()).share!
  commandKey = testUuid()
  const response = await call(`${root}/${share.id}/revoke`, { value: {}, headers: { Cookie: sessionCookie } })
  expect(response.status).toBe(200)
  const receipt = await response.json()
  expect(receipt).toMatchObject({ source: 'cloudflare', commandId: commandKey, shareId: share.id, revoked: true })
  expect(
    await (await call(`${root}/${share.id}/revoke`, { value: {}, headers: { Cookie: sessionCookie } })).json()
  ).toEqual(receipt)
  expect(
    (await call('/api/cart/shared/resolve', { value: { id: share.id, token: share.token }, headers: { Cookie: '' } }))
      .status
  ).toBe(404)
})
it.each(['session-only', 'cart-only', 'duplicate-cart'])(
  'requires both current credentials for creation: %s',
  async (boundary) => {
    const Cookie =
      boundary === 'session-only'
        ? sessionCookie
        : boundary === 'cart-only'
          ? cartCookie
          : `${sessionCookie}; ${cartCookie}; ${cartCookie}`
    expect((await call(root, { headers: { Cookie } })).status).toBe(401)
  }
)
it('honors live session revocation before looking up a previously applied command', async () => {
  expect((await call()).status).toBe(201)
  fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
  expect(
    (
      await call(root + '/commands/' + commandKey, {
        method: 'GET',
        headers: { 'X-Neteco-Command-Payload-Hash': await cartSnapshotIntentHash(input()) }
      })
    ).status
  ).toBe(401)
})
it('does not list or revoke another customer share even when its UUID is known', async () => {
  const created = await call()
  expect(created.status).toBe(201)
  const result = cartSnapshotResponseSchema.parse(await created.json())
  const identityId = testUuid(),
    sessionId = testUuid(),
    customerId = testUuid(),
    now = utc()
  fixture.sqlite
    .prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,'Other synthetic customer',?,?)")
    .run(customerId, now, now)
  fixture.sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'other-snapshot@example.invalid','synthetic',?,'active',?,?,?)"
    )
    .run(identityId, now, customerId, now, now)
  fixture.sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
    )
    .run(sessionId, identityId, now, utc(3600000))
  const Cookie = (await issueD1SessionCookie(
    fixture.database,
    { identityId, sessionId, sessionVersion: 1 },
    configuration
  ))!.split(';')[0]!
  const listed = await call(root, { method: 'GET', headers: { Cookie } })
  expect(listed.status).toBe(200)
  expect(await listed.json()).toEqual({ source: 'cloudflare', items: [] })
  expect((await call(`${root}/${result.share!.id}/revoke`, { value: {}, headers: { Cookie } })).status).toBe(404)
})
it.each([
  { ...input(), lines: [{ variantId: 'v-1-1', quantity: 99 }] },
  { ...input(), couponCode: 'PRIVATE' },
  { ...input(), price: 1 }
])('rejects client-supplied snapshot facts', async (value) => {
  expect((await call(root, { value })).status).toBe(400)
})
it('rejects URL credentials, cross-origin requests and invalid bodies', async () => {
  expect((await call('/api/cart/shared/resolve?token=private', { value: {} })).status).toBe(400)
  expect((await call(root, { headers: { Origin: 'https://foreign.neteco.test' } })).status).toBe(403)
  expect((await call(root, { raw: new Uint8Array([0xff]) })).status).toBe(400)
  expect((await call(root, { raw: ' '.repeat(8193) })).status).toBe(413)
  expect((await call(root, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
})
it('fails closed on edge limits and D1 outage instead of fabricating an empty list', async () => {
  edge.limit = async () => ({ success: false })
  expect((await call()).status).toBe(429)
  edge.limit = async () => ({ success: true })
  const database = {
    prepare() {
      throw new Error('private_fixture_failure')
    }
  } as unknown as D1Database
  const response = await call(root, { method: 'GET', database })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
})
