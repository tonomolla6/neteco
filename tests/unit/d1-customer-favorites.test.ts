import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  createD1FavoriteList,
  deleteD1FavoriteList,
  listD1CustomerFavorites,
  prepareD1FavoriteListForCart,
  removeD1CustomerFavorite,
  renameD1FavoriteList,
  saveD1CustomerFavorite
} from '../../workers/catalog/customer-favorites'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-25T09:00:00Z'
const A = '10000000-0000-4000-8000-000000000071'
const B = '10000000-0000-4000-8000-000000000072'
const CA = '30000000-0000-4000-8000-000000000071'
const CB = '30000000-0000-4000-8000-000000000072'
const SA = '20000000-0000-4000-8000-000000000071'
const SB = '20000000-0000-4000-8000-000000000072'
const config = { password: randomBytes(32).toString('hex'), maxAgeSeconds: 3600 }

describe('D1 customer favorites and simple lists', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookieA: string
  let cookieB: string
  let publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>

  function request(cookie = cookieA) {
    return new Request('https://neteco.invalid/api/account/favorites', { headers: { cookie } })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    publication = await provisionPublicationValidityFixture(database, { productIds: ['p-1', 'p-2', 'p-3'], now: NOW })
    for (const [identity, customer, session, email] of [
      [A, CA, SA, 'favorite-a@example.invalid'],
      [B, CB, SB, 'favorite-b@example.invalid']
    ]) {
      sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customer, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, email_verified_at, status,
        customer_id, created_at, updated_at) VALUES (?, ?, 'synthetic', ?, 'active', ?, ?, ?)`
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
      config
    ))!.split(';')[0]!
    cookieB = (await issueD1SessionCookie(
      database,
      { identityId: B, sessionId: SB, sessionVersion: 1 },
      config
    ))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  it('persists a default list, returns the existing account UI shape and isolates both customers', async () => {
    const saved = await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 2 })
    expect(saved).toMatchObject({ ok: true })
    const id = (saved as { id: string }).id
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await listD1CustomerFavorites(database, request(), config)).toEqual({
      lists: [
        {
          id,
          name: 'Favoritos',
          isDefault: true,
          items: [
            {
              variantId: 'v-1-1',
              cartVariantId: 11,
              sku: 'SKU-1-1',
              quantity: '2',
              name: 'Producto 1',
              slug: 'producto-1',
              format: 'Botella 1 L',
              unitLabel: 'unidad',
              minimumQuantity: 1,
              maximumQuantity: null,
              quantityIncrement: 1,
              available: true,
              reason: null
            }
          ]
        }
      ]
    })
    expect(await listD1CustomerFavorites(database, request(cookieB), config)).toEqual({ lists: [] })
    expect(await removeD1CustomerFavorite(database, request(cookieB), config, 'v-1-1')).toEqual({
      ok: false,
      code: 'not_found'
    })
    expect(await prepareD1FavoriteListForCart(database, request(cookieB), config, id)).toEqual({ outcome: 'not_found' })
    expect(await removeD1CustomerFavorite(database, request(), config, 'v-1-1')).toEqual({ ok: true, id })
    expect((await listD1CustomerFavorites(database, request(), config))?.lists[0]?.items).toEqual([])
  })

  it('supports private named lists, bounded names, rename and cascade delete without touching the default', async () => {
    const defaultList = await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1' })
    const named = await createD1FavoriteList(database, request(), config, 'Reposición mensual')
    expect(named).toMatchObject({ ok: true })
    const id = (named as { id: string }).id
    expect(id).not.toBe((defaultList as { id: string }).id)
    expect(await createD1FavoriteList(database, request(), config, 'Reposición mensual')).toEqual({
      ok: false,
      code: 'already_exists'
    })
    expect(await createD1FavoriteList(database, request(), config, 'Favoritos')).toEqual({
      ok: false,
      code: 'invalid_input'
    })
    expect(await createD1FavoriteList(database, request(), config, ' X ')).toEqual({ ok: false, code: 'invalid_input' })
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-2-1', listId: id })).toEqual({
      ok: true,
      id
    })
    expect(
      await saveD1CustomerFavorite(database, request(cookieB), config, { variantId: 'v-3-1', listId: id })
    ).toEqual({ ok: false, code: 'not_found' })
    expect(await renameD1FavoriteList(database, request(cookieB), config, id, 'Robada')).toEqual({
      ok: false,
      code: 'not_found'
    })
    expect(await renameD1FavoriteList(database, request(), config, id, 'Compras de otoño')).toEqual({ ok: true, id })
    expect(await deleteD1FavoriteList(database, request(cookieB), config, id)).toEqual({ ok: false, code: 'not_found' })
    expect(await deleteD1FavoriteList(database, request(), config, id)).toEqual({ ok: true, id })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items WHERE list_id = ?').get(id)).toEqual({
      n: 0
    })
    expect(await deleteD1FavoriteList(database, request(), config, (defaultList as { id: string }).id)).toEqual({
      ok: false,
      code: 'not_found'
    })
  })

  it('keeps withdrawn-policy favorites visible as unavailable, denies upsert and still allows removal', async () => {
    const saved = await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 2 })
    if (!saved.ok) throw new Error(saved.code)
    expect((await listD1CustomerFavorites(database, request(), config))?.lists[0]?.items[0]).toMatchObject({
      available: true,
      reason: null
    })
    sqlite
      .prepare(
        `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
      SELECT ?,id,actor_id,'Synthetic fixture policy withdrawal',? FROM catalog_publication_policies WHERE id=?`
      )
      .run(testUuid(), NOW, publication.policyId)
    expect((await listD1CustomerFavorites(database, request(), config))?.lists[0]?.items[0]).toMatchObject({
      variantId: 'v-1-1',
      quantity: '2',
      available: false,
      reason: 'unpublished'
    })
    expect(await prepareD1FavoriteListForCart(database, request(), config, saved.id)).toMatchObject({
      outcome: 'ready',
      ready: [],
      unavailable: [{ variantId: 'v-1-1', available: false, reason: 'unpublished' }]
    })
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 3 })).toEqual({
      ok: false,
      code: 'not_available'
    })
    expect(sqlite.prepare('SELECT quantity FROM customer_favorite_items WHERE list_id=?').get(saved.id)).toEqual({
      quantity: 2
    })
    expect(await removeD1CustomerFavorite(database, request(), config, 'v-1-1', saved.id)).toEqual({
      ok: true,
      id: saved.id
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM cart_commands').get()).toEqual({ n: 0 })
  })

  it('rolls back a first favorite when its policy is withdrawn between validation and batch', async () => {
    let batches = 0
    const raced = new Proxy(database, {
      get(target, property) {
        if (property !== 'batch') return Reflect.get(target, property)
        return async (statements: Parameters<D1Database['batch']>[0]) => {
          batches += 1
          sqlite
            .prepare(
              `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
            SELECT ?,id,actor_id,'Synthetic fixture withdrawal before batch',? FROM catalog_publication_policies WHERE id=?`
            )
            .run(testUuid(), NOW, publication.policyId)
          return target.batch(statements)
        }
      }
    })
    expect(await saveD1CustomerFavorite(raced, request(), config, { variantId: 'v-1-1', quantity: 2 })).toEqual({
      ok: false,
      code: 'not_available'
    })
    expect(batches).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it('rejects stale sessions and unverified identities in every read/write path', async () => {
    expect(await listD1CustomerFavorites(database, request(''), config)).toBeNull()
    expect(await saveD1CustomerFavorite(database, request(''), config, { variantId: 'v-1-1' })).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    expect(await saveD1CustomerFavorite(database, request(cookieA), config, { variantId: 'v-1-1' })).toMatchObject({
      ok: true
    })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
    expect(await listD1CustomerFavorites(database, request(), config)).toBeNull()
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-2-1' })).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    expect(await removeD1CustomerFavorite(database, request(), config, 'v-1-1')).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    expect(await createD1FavoriteList(database, request(), config, 'Nueva')).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = NULL WHERE id = ?').run(SA)
    sqlite.prepare('UPDATE identities SET email_verified_at = NULL WHERE id = ?').run(A)
    expect(await listD1CustomerFavorites(database, request(), config)).toBeNull()
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-2-1' })).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    sqlite.prepare('UPDATE identities SET email_verified_at = ? WHERE id = ?').run(NOW, A)
    sqlite
      .prepare(
        `INSERT INTO identity_mfa(identity_id, encrypted_secret, verified_at, updated_at)
      VALUES (?, 'synthetic-only', ?, ?)`
      )
      .run(A, NOW, NOW)
    expect(await listD1CustomerFavorites(database, request(), config)).toBeNull()
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-2-1' })).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified = 1 WHERE id = ?').run(SA)
    expect((await listD1CustomerFavorites(database, request(), config))?.lists).toHaveLength(1)
  })

  it('rechecks publication, category, stock and changed quantity policy before cart preparation', async () => {
    expect(
      await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 2 })
    ).toMatchObject({ ok: true })
    expect(
      await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-2-1', quantity: 2 })
    ).toMatchObject({ ok: true })
    const listId = (await listD1CustomerFavorites(database, request(), config))!.lists[0]!.id
    sqlite.prepare('UPDATE variants SET minimum_quantity = 3, quantity_increment = 2 WHERE id = ?').run('v-1-1')
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity = 0 WHERE variant_id = ?').run('v-2-1')
    let plan = await prepareD1FavoriteListForCart(database, request(), config, listId)
    expect(plan).toMatchObject({
      outcome: 'ready',
      ready: [],
      unavailable: [
        { variantId: 'v-1-1', reason: 'quantity_changed' },
        { variantId: 'v-2-1', reason: 'out_of_stock' }
      ]
    })
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 2 })).toEqual({
      ok: false,
      code: 'invalid_input'
    })
    expect(
      await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 3 })
    ).toMatchObject({ ok: true })
    sqlite.prepare("UPDATE categories SET status = 'hidden' WHERE id = 'c1'").run()
    plan = await prepareD1FavoriteListForCart(database, request(), config, listId)
    expect(plan).toMatchObject({
      outcome: 'ready',
      ready: [],
      unavailable: [
        { variantId: 'v-1-1', reason: 'unpublished' },
        { variantId: 'v-2-1', reason: 'unpublished' }
      ]
    })
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-3-1' })).toEqual({
      ok: false,
      code: 'not_available'
    })
  })

  it('enforces quantity and item-count bounds while allowing updates at the cap', async () => {
    for (const quantity of [0, -1, 1.5, 1000, '2', Number.NaN]) {
      expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity })).toEqual({
        ok: false,
        code: 'invalid_input'
      })
    }
    const first = await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1' })
    const id = (first as { id: string }).id
    const insertVariant = sqlite.prepare(`INSERT INTO variants(id, legacy_id, product_id, tax_class_id,
      shipping_profile_id, sku, mpn, format, status, price_gross_cents)
      VALUES (?, ?, 'p-1', 't21', 'sp1', ?, ?, 'Botella', 'published', 500)`)
    const insertItem =
      sqlite.prepare(`INSERT INTO customer_favorite_items(list_id, variant_id, quantity, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)`)
    for (let index = 0; index < 100; index++) {
      insertVariant.run(`v-extra-${index}`, 1000 + index, `SKU-EXTRA-${index}`, `SYNTHETIC-EXTRA-${index}`)
      if (index < 99) insertItem.run(id, `v-extra-${index}`, NOW, NOW)
    }
    expect(() =>
      sqlite.prepare('UPDATE customer_favorite_items SET quantity = 1000 WHERE list_id = ?').run(id)
    ).toThrow()
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1', quantity: 4 })).toEqual({
      ok: true,
      id
    })
    expect(await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-extra-99' })).toEqual({
      ok: false,
      code: 'limit_reached'
    })
    expect(
      sqlite
        .prepare('SELECT quantity FROM customer_favorite_items WHERE list_id = ? AND variant_id = ?')
        .get(id, 'v-1-1')
    ).toEqual({ quantity: 4 })
  })

  it('reserves the default list even after twenty named lists', async () => {
    for (let index = 0; index < 20; index++) {
      const created = await createD1FavoriteList(database, request(), config, `Lista ${index}`)
      expect(created.ok).toBe(true)
    }
    expect(await createD1FavoriteList(database, request(), config, 'Lista 21')).toEqual({
      ok: false,
      code: 'limit_reached'
    })
    const saved = await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1' })
    expect(saved.ok).toBe(true)
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists WHERE customer_id = ?').get(CA)).toEqual({
      n: 21
    })
    expect(
      sqlite
        .prepare('SELECT count(*) AS n FROM customer_favorite_lists WHERE customer_id = ? AND is_default = 1')
        .get(CA)
    ).toEqual({
      n: 1
    })
  })

  it('rolls back creation of the default when the item write fails', async () => {
    sqlite.exec(`CREATE TRIGGER reject_favorite_item BEFORE INSERT ON customer_favorite_items
      BEGIN SELECT RAISE(ABORT, 'synthetic favorite item failure'); END`)
    await expect(saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1' })).rejects.toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it('classifies publication and quantity races without leaving an empty default', async () => {
    function raceBeforeBatch(change: () => void): D1Database {
      return new Proxy(database, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: Parameters<D1Database['batch']>[0]) => {
              change()
              return target.batch(statements)
            }
          return Reflect.get(target, property)
        }
      })
    }

    const unpublished = raceBeforeBatch(() =>
      sqlite.prepare("UPDATE categories SET status = 'hidden' WHERE id = 'c1'").run()
    )
    expect(await saveD1CustomerFavorite(unpublished, request(), config, { variantId: 'v-1-1', quantity: 2 })).toEqual({
      ok: false,
      code: 'not_available'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists').get()).toEqual({ n: 0 })

    sqlite.prepare("UPDATE categories SET status = 'published' WHERE id = 'c1'").run()
    const changedRules = raceBeforeBatch(() =>
      sqlite.prepare('UPDATE variants SET minimum_quantity = 3, quantity_increment = 2 WHERE id = ?').run('v-1-1')
    )
    expect(await saveD1CustomerFavorite(changedRules, request(), config, { variantId: 'v-1-1', quantity: 2 })).toEqual({
      ok: false,
      code: 'invalid_input'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists').get()).toEqual({ n: 0 })
  })

  it('refuses a session revoked after validation but before its transactional write', async () => {
    const revokedBeforeBatch = new Proxy(database, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
            return target.batch(statements)
          }
        return Reflect.get(target, property)
      }
    })
    expect(await saveD1CustomerFavorite(revokedBeforeBatch, request(), config, { variantId: 'v-1-1' })).toEqual({
      ok: false,
      code: 'unauthenticated'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_lists').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_favorite_items').get()).toEqual({ n: 0 })
  })

  it('returns unauthenticated when a concurrent revocation interrupts the list read', async () => {
    await saveD1CustomerFavorite(database, request(), config, { variantId: 'v-1-1' })
    const interruptedRead = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (sql.includes('LEFT JOIN customer_favorite_items'))
              sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
            return target.prepare(sql)
          }
        return Reflect.get(target, property)
      }
    })
    expect(await listD1CustomerFavorites(interruptedRead, request(), config)).toBeNull()
  })
})
