import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerFavoritesHttp } from '../../workers/catalog/customer-favorites-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

describe('favorite list UUID compatibility', () => {
  const now = '2026-09-25T09:00:00Z'
  const origin = 'https://neteco.invalid'
  const root = '/api/account/favorites'
  const variantId = '40000000-0000-0000-0000-000000000071'
  const listId = '50000000-0000-0000-0000-000000000071'
  const identityId = '10000000-0000-4000-8000-000000000071'
  const customerId = '30000000-0000-4000-8000-000000000071'
  const sessionId = '20000000-0000-4000-8000-000000000071'
  const otherIdentityId = '10000000-0000-4000-8000-000000000072'
  const otherCustomerId = '30000000-0000-4000-8000-000000000072'
  const otherSessionId = '20000000-0000-4000-8000-000000000072'
  const config = {
    password: 'synthetic-favorites-cookie-password-at-least-32-chars',
    maxAgeSeconds: 3600,
    origin,
    tokenPepper: 'synthetic-favorites-pepper-at-least-32-chars'
  }
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  let otherCookie: string

  async function send(path: string, method = 'GET', body?: unknown, credentials = cookie) {
    return (await handleCustomerFavoritesHttp(
      new Request(`${origin}${path}`, {
        method,
        headers: { cookie: credentials, origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      { database, edgeLimiter: { limit: async () => ({ success: true }) } as RateLimit, configuration: () => config }
    ))!
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now })
    sqlite
      .prepare(
        `INSERT INTO variants(id, legacy_id, product_id, tax_class_id, shipping_profile_id,
          sku, mpn, format, status, price_gross_cents, backorder_allowed)
         VALUES (?, 99, 'p-1', 't21', 'sp1', 'LEGACY-UUID', 'LEGACY-UUID', 'Caja', 'published', 500, 1)`
      )
      .run(variantId)
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customerId, now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
         VALUES (?, 'favorite@example.invalid', 'synthetic', ?, 'active', ?, ?, ?)`
      )
      .run(identityId, now, customerId, now, now)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-09-25T08:00:00Z', '2026-09-25T10:00:00Z')`
      )
      .run(sessionId, identityId)
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(otherCustomerId, now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
         VALUES (?, 'other@example.invalid', 'synthetic', ?, 'active', ?, ?, ?)`
      )
      .run(otherIdentityId, now, otherCustomerId, now, now)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-09-25T08:00:00Z', '2026-09-25T10:00:00Z')`
      )
      .run(otherSessionId, otherIdentityId)
    sqlite
      .prepare(
        'INSERT INTO customer_favorite_lists(id, customer_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(listId, customerId, 'Lista previa', now, now)
    const issued = await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, config)
    expect(issued).not.toBeNull()
    cookie = issued!.split(';')[0]!
    const otherIssued = await issueD1SessionCookie(
      database,
      { identityId: otherIdentityId, sessionId: otherSessionId, sessionVersion: 1 },
      config
    )
    expect(otherIssued).not.toBeNull()
    otherCookie = otherIssued!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  it('saves, reads and removes a legacy-shaped variant in a legacy-shaped list', async () => {
    const saved = await send(root, 'POST', { variantId, listId, quantity: 2 })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ variantId, listId, quantity: 2 })
    const listed = await send(root)
    expect(await listed.json()).toMatchObject({ lists: [{ id: listId, items: [{ variantId, quantity: '2' }] }] })
    expect((await send(`${root}/${variantId}?listId=${listId}`, 'DELETE')).status).toBe(200)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it('allows list operations on prior UUID-shaped identifiers and rejects malformed or anonymous requests', async () => {
    expect((await send(`${root}/lists/${listId}`, 'PUT', { name: 'Renombrada' })).status).toBe(200)
    expect((await send(`${root}/lists/${listId}/cart`, 'POST')).status).toBe(200)
    expect((await send(`${root}/lists/not-a-uuid`, 'DELETE')).status).toBe(400)
    expect((await send(`${root}/lists/${listId}`, 'DELETE', undefined, '')).status).toBe(401)
    expect((await send(`${root}/lists/${listId}`, 'DELETE', undefined, otherCookie)).status).toBe(404)
    expect((await send(`${root}/lists/${listId}`, 'DELETE')).status).toBe(200)
  })
})
