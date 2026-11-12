import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerFavoritesHttp } from '../../workers/catalog/customer-favorites-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-25T09:00:00Z'
const A = '10000000-0000-4000-8000-000000000071'
const B = '10000000-0000-4000-8000-000000000072'
const CA = '30000000-0000-4000-8000-000000000071'
const CB = '30000000-0000-4000-8000-000000000072'
const SA = '20000000-0000-4000-8000-000000000071'
const SB = '20000000-0000-4000-8000-000000000072'
const V = '40000000-0000-4000-8000-000000000071'
const root = '/api/account/favorites'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex')
}

describe('D1 account favorites HTTP boundary on real SQLite', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookieA: string
  let cookieB: string
  let publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  function request(
    path = root,
    method = 'GET',
    body?: unknown,
    cookie = cookieA,
    headers: Record<string, string> = {}
  ) {
    return new Request(`${configuration.origin}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        cookie,
        origin: configuration.origin,
        'content-type': 'application/json',
        'cf-connecting-ip': '192.0.2.1',
        ...headers
      }
    })
  }
  async function handle(req: Request) {
    return (await handleCustomerFavoritesHttp(req, {
      database,
      edgeLimiter: limiter,
      configuration: () => configuration
    }))!
  }
  async function save(variantId: number | string = 11, listId?: string) {
    const response = await handle(request(root, 'POST', { variantId, quantity: 2, ...(listId ? { listId } : {}) }))
    expect(response.status).toBe(201)
    return response.json() as Promise<{ listId: string; variantId: string; quantity: number }>
  }
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    publication = await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
    sqlite
      .prepare(
        `INSERT INTO variants(id, legacy_id, product_id, tax_class_id, shipping_profile_id,
      sku, mpn, format, status, price_gross_cents, backorder_allowed)
      VALUES (?, 99, 'p-1', 't21', 'sp1', 'UUID-SKU', 'SYNTHETIC-UUID-SKU', 'Caja', 'published', 500, 1)`
      )
      .run(V)
    for (const [identity, customer, session, email] of [
      [A, CA, SA, 'owner-a@example.invalid'],
      [B, CB, SB, 'owner-b@example.invalid']
    ]) {
      sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
        VALUES (?, ?, 'synthetic', ?, 'active', ?, ?, ?)`
        )
        .run(identity, email, NOW, customer, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
        VALUES (?, ?, 1, '2026-09-25T08:00:00Z', '2026-09-25T10:00:00Z')`
        )
        .run(session, identity)
    }
    cookieA = (await issueD1SessionCookie(
      database,
      { identityId: A, sessionId: SA, sessionVersion: 1 },
      configuration
    ))!.split(';')[0]!
    cookieB = (await issueD1SessionCookie(
      database,
      { identityId: B, sessionId: SB, sessionVersion: 1 },
      configuration
    ))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  it('retains Node POST/GET contract and maps UUIDs to numeric cart identifiers only through D1', async () => {
    const saved = await save(V)
    expect(saved).toEqual({ listId: expect.any(String), variantId: V, quantity: 2 })
    const read = await handle(request())
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(await read.json()).toMatchObject({
      lists: [{ id: saved.listId, isDefault: true, items: [{ variantId: V, cartVariantId: 99 }] }]
    })
    const plan = await handle(request(`${root}/lists/${saved.listId}/cart`, 'POST'))
    expect(await plan.json()).toMatchObject({
      outcome: 'ready',
      ready: [{ variantId: V, cartVariantId: 99, quantity: 2 }]
    })
    expect(await save(99)).toEqual(saved)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 1 })
  })

  it('never trusts body/query customer identity or a forged identity header', async () => {
    for (const body of [
      { variantId: 11, customerId: CB },
      { variantId: 11, identityId: B },
      { variantId: 11, email: 'owner-b@example.invalid' },
      { variantId: 11, cartVariantId: 99 }
    ])
      expect((await handle(request(root, 'POST', body))).status).toBe(400)
    expect((await handle(request(`${root}?customerId=${CB}`))).status).toBe(400)
    const forged = await handle(
      request(root, 'POST', { variantId: 11 }, cookieA, { 'x-customer-id': CB, 'x-identity-id': B })
    )
    expect(forged.status).toBe(201)
    expect(sqlite.prepare('SELECT customer_id FROM customer_favorite_lists').get()).toEqual({ customer_id: CA })
    expect((await handle(request(root, 'POST', { variantId: 11 }, ''))).status).toBe(401)
  })

  it('uses only persisted customer linkage when email changes or linkage is removed', async () => {
    await save(V)
    sqlite.prepare('UPDATE identities SET email = ? WHERE id = ?').run('new-account-name@example.invalid', A)
    expect(await (await handle(request())).json()).toMatchObject({ lists: [{ items: [{ variantId: V }] }] })
    sqlite.prepare('UPDATE identities SET customer_id = NULL WHERE id = ?').run(A)
    expect((await handle(request())).status).toBe(401)
    expect((await handle(request(root, 'POST', { variantId: V }))).status).toBe(401)
    expect(sqlite.prepare('SELECT customer_id FROM customer_favorite_lists').get()).toEqual({ customer_id: CA })
  })

  it('supports private named list CRUD and item deletion is scoped to the requested list', async () => {
    const defaultList = await save(V)
    const created = await handle(request(`${root}/lists`, 'POST', { name: 'Compras mensuales' }))
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    await save(V, id)
    expect((await handle(request(`${root}/lists/${id}`, 'PUT', { name: 'Otra' }, cookieB))).status).toBe(404)
    expect((await handle(request(`${root}/lists/${id}`, 'DELETE', undefined, cookieB))).status).toBe(404)
    expect((await handle(request(`${root}/lists/${id}/cart`, 'POST', undefined, cookieB))).status).toBe(404)
    expect((await handle(request(root, 'POST', { variantId: V, listId: id }, cookieB))).status).toBe(404)
    expect((await handle(request(`${root}/${V}?listId=${id}`, 'DELETE', undefined, cookieB))).status).toBe(404)
    expect(await (await handle(request(root, 'GET', undefined, cookieB))).json()).toEqual({ lists: [] })
    expect((await handle(request(`${root}/lists/${id}`, 'PUT', { name: 'Reposición' }))).status).toBe(200)
    expect((await handle(request(`${root}/${V}?listId=${id}`, 'DELETE'))).status).toBe(200)
    expect(sqlite.prepare('SELECT list_id FROM customer_favorite_items WHERE variant_id = ?').all(V)).toEqual([
      { list_id: defaultList.listId }
    ])
    expect((await handle(request(`${root}/lists/${defaultList.listId}`, 'DELETE'))).status).toBe(404)
    expect((await handle(request(`${root}/lists/${id}`, 'DELETE'))).status).toBe(200)
  })

  it('allows removing a legacy numeric favorite even after unpublishing', async () => {
    await save(V)
    sqlite.prepare("UPDATE variants SET status = 'hidden' WHERE id = ?").run(V)
    expect((await handle(request(`${root}/99`, 'DELETE'))).status).toBe(200)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it('withdrawal blocks preparation and upsert without hiding the saved reference or preventing removal', async () => {
    const { listId } = await save(V)
    sqlite
      .prepare(
        `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
      SELECT ?,id,actor_id,'Synthetic HTTP fixture policy withdrawal',? FROM catalog_publication_policies WHERE id=?`
      )
      .run(testUuid(), NOW, publication.policyId)
    const read = await handle(request())
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(await read.json()).toMatchObject({
      lists: [{ id: listId, items: [{ variantId: V, quantity: '2', available: false, reason: 'unpublished' }] }]
    })
    const prepared = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toMatchObject({
      outcome: 'ready',
      ready: [],
      unavailable: [{ variantId: V, reason: 'unpublished' }]
    })
    expect((await handle(request(root, 'POST', { variantId: V, quantity: 3, listId }))).status).toBe(422)
    expect(sqlite.prepare('SELECT quantity FROM customer_favorite_items').get()).toEqual({ quantity: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_commands').get()).toEqual({ n: 0 })
    expect((await handle(request(`${root}/99?listId=${listId}`, 'DELETE'))).status).toBe(200)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it.each(['revoke', 'session_version', 'customer_disabled', 'identity_disabled', 'unverified', 'mfa'])(
    'rechecks persisted authorization: %s',
    async (change) => {
      const saved = await save(V)
      if (change === 'revoke') sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
      if (change === 'session_version') sqlite.prepare('UPDATE identities SET session_version = 2 WHERE id = ?').run(A)
      if (change === 'customer_disabled') sqlite.prepare("UPDATE customers SET status = 'blocked' WHERE id = ?").run(CA)
      if (change === 'identity_disabled')
        sqlite.prepare("UPDATE identities SET status = 'disabled' WHERE id = ?").run(A)
      if (change === 'unverified') sqlite.prepare('UPDATE identities SET email_verified_at = NULL WHERE id = ?').run(A)
      if (change === 'mfa')
        sqlite
          .prepare(
            `INSERT INTO identity_mfa(identity_id, encrypted_secret, verified_at, updated_at) VALUES (?, 'synthetic', ?, ?)`
          )
          .run(A, NOW, NOW)
      for (const [path, method, body] of [
        [root, 'GET', undefined],
        [root, 'POST', { variantId: V }],
        [`${root}/${V}`, 'DELETE', undefined],
        [`${root}/lists`, 'POST', { name: 'Nueva' }],
        [`${root}/lists/${saved.listId}/cart`, 'POST', undefined]
      ] as const)
        expect((await handle(request(path, method, body))).status).toBe(401)
      expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 1 })
    }
  )

  it('rechecks publication and quantity changes on preparation instead of trusting rendered availability', async () => {
    const { listId } = await save(V)
    sqlite.prepare("UPDATE categories SET status = 'hidden' WHERE id = 'c1'").run()
    let plan = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await plan.json()).toMatchObject({ ready: [], unavailable: [{ variantId: V, reason: 'unpublished' }] })
    expect((await handle(request(root, 'POST', { variantId: V }))).status).toBe(422)
    sqlite.prepare("UPDATE categories SET status = 'published' WHERE id = 'c1'").run()
    sqlite.prepare('UPDATE variants SET minimum_quantity = 3 WHERE id = ?').run(V)
    plan = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await plan.json()).toMatchObject({ ready: [], unavailable: [{ reason: 'quantity_changed' }] })
    expect((await handle(request(root, 'POST', { variantId: V, quantity: 2 }))).status).toBe(400)
  })

  it.each(['variant', 'product'])('blocks cart preparation after %s publication changes', async (scope) => {
    const { listId } = await save(V)
    if (scope === 'variant') sqlite.prepare("UPDATE variants SET status = 'hidden' WHERE id = ?").run(V)
    else sqlite.prepare("UPDATE products SET status = 'hidden' WHERE id = 'p-1'").run()
    const response = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await response.json()).toMatchObject({ ready: [], unavailable: [{ variantId: V, reason: 'unpublished' }] })
    expect((await handle(request(root, 'POST', { variantId: V }))).status).toBe(422)
  })

  it('blocks preparation when stock disappeared but permits documented backorders', async () => {
    const { listId } = await save(11)
    sqlite.prepare("UPDATE inventory_balances SET physical_quantity = 0 WHERE variant_id = 'v-1-1'").run()
    const response = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await response.json()).toMatchObject({
      ready: [],
      unavailable: [{ cartVariantId: 11, reason: 'out_of_stock' }]
    })
    sqlite.prepare("UPDATE variants SET backorder_allowed = 1 WHERE id = 'v-1-1'").run()
    expect(await (await handle(request(`${root}/lists/${listId}/cart`, 'POST'))).json()).toMatchObject({
      ready: [{ cartVariantId: 11, quantity: 2 }],
      unavailable: []
    })
  })

  it('does not coerce an unmapped UUID to a number and picks up authoritative mapping changes', async () => {
    const { listId } = await save(V)
    sqlite.prepare('UPDATE variants SET legacy_id = NULL WHERE id = ?').run(V)
    const plan = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await plan.json()).toMatchObject({
      ready: [],
      unavailable: [{ variantId: V, cartVariantId: null, reason: 'unpublished' }]
    })
    sqlite.prepare('UPDATE variants SET legacy_id = 101 WHERE id = ?').run(V)
    const current = await handle(request(`${root}/lists/${listId}/cart`, 'POST'))
    expect(await current.json()).toMatchObject({ ready: [{ variantId: V, cartVariantId: 101 }], unavailable: [] })
  })

  it('rejects CSRF, unexpected methods/paths, ambiguous query IDs and invalid input', async () => {
    const crossSite = await handle(
      request(root, 'POST', { variantId: V }, cookieA, { origin: 'https://attacker.invalid' })
    )
    expect(crossSite.status).toBe(403)
    expect((await handle(request(root, 'GET', undefined, cookieA, { 'sec-fetch-site': 'cross-site' }))).status).toBe(
      403
    )
    const method = await handle(request(root, 'PUT', { variantId: V }))
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET, POST')
    expect((await handle(request(`${root}/unexpected/subpath`))).status).toBe(404)
    expect(
      await handleCustomerFavoritesHttp(request('/api/products'), {
        database,
        edgeLimiter: limiter,
        configuration: () => configuration
      })
    ).toBeNull()
    for (const variantId of ['99', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'not-a-uuid'])
      expect((await handle(request(root, 'POST', { variantId }))).status).toBe(400)
    for (const quantity of [0, -1, 1.5, 1000, '2', null])
      expect((await handle(request(root, 'POST', { variantId: V, quantity }))).status).toBe(400)
    expect((await handle(request(`${root}/${V}?listId=${CA}&listId=${CB}`, 'DELETE'))).status).toBe(400)
  })

  it('bounds streaming bodies, validates media type, and fails closed on unavailable abuse/auth controls', async () => {
    expect(
      (await handle(request(root, 'POST', { variantId: V }, cookieA, { 'content-type': 'text/plain' }))).status
    ).toBe(415)
    expect((await handle(request(root, 'POST', { variantId: V, padding: 'x'.repeat(4096) }))).status).toBe(413)
    const malformed = new Request(`${configuration.origin}${root}`, {
      method: 'POST',
      body: '{',
      headers: {
        cookie: cookieA,
        origin: configuration.origin,
        'content-type': 'application/json',
        'cf-connecting-ip': '192.0.2.1'
      }
    })
    expect((await handle(malformed)).status).toBe(400)
    limiter.limit.mockResolvedValueOnce({ success: false })
    expect((await handle(request())).status).toBe(429)
    limiter.limit.mockRejectedValueOnce(new Error('synthetic unavailable'))
    expect((await handle(request())).status).toBe(503)
    expect(
      (await handleCustomerFavoritesHttp(request(), { database, edgeLimiter: limiter, configuration: () => null }))!
        .status
    ).toBe(503)
    expect(
      (await handleCustomerFavoritesHttp(request(), {
        database,
        edgeLimiter: limiter,
        configuration: () => ({ ...configuration, password: '' })
      }))!.status
    ).toBe(503)
  })
})
