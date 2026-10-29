import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { returnsFixture, BUYER_CLAIMS, BUYER_SESSION, BUYER, CUSTOMER, utc } from './d1-returns-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import {
  saveD1CartSnapshot,
  listD1CartSnapshots,
  readD1CartSnapshotCommand,
  resolveD1SharedCart,
  revokeD1CartShare,
  type CartSnapshotAccess
} from '../../workers/catalog/cart-snapshots'
import {
  cartSnapshotInputSchema,
  cartSnapshotIntentHash,
  cartSnapshotRevokeIntentHash,
  cartSnapshotResponseSchema,
  sharedCartResolveResponseSchema
} from '../../shared/cart-snapshots'

const KEY = deterministicUuid('cart-snapshot-create-command')
const REVOKE_KEY = deterministicUuid('cart-snapshot-revoke-command')
const body = { name: 'Synthetic saved basket', expectedCartVersion: 2, createShare: false }
let sqlite: DatabaseSync
let database: D1Database
let access: CartSnapshotAccess
beforeEach(async () => {
  const fixture = await returnsFixture()
  sqlite = fixture.sqlite
  database = fixture.database
  const migration = await readFile(new URL('../../db/d1/migrations/0075_cart_snapshots.sql', import.meta.url), 'utf8')
  await database.batch(splitDemoSql(migration).map((sql) => database.prepare(sql)))
  const cart = await createCart(database, { correlationId: 'snapshot-test', now: utc() })
  await setCartLine(database, {
    cartId: cart.cartId,
    token: cart.token,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'snapshot-line',
    correlationId: 'snapshot-test',
    now: utc()
  })
  access = { claims: BUYER_CLAIMS, cartId: cart.cartId, cartToken: cart.token }
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})
const save = (raw: unknown = body, key = KEY) => saveD1CartSnapshot(database, access, raw, { idempotencyKey: key })
function inventory() {
  return [
    'inventory_balances',
    'inventory_movements',
    'inventory_reservations',
    'inventory_reservation_lines',
    'orders',
    'payment_intents'
  ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}

it('saves a new owner list with server cart quantities and no sharing by default, without stock/money/cart mutations', async () => {
  const before = inventory(),
    cartBefore = sqlite.prepare('SELECT * FROM carts WHERE id=?').get(access.cartId)
  const result = cartSnapshotResponseSchema.parse(await save())
  expect(result).toMatchObject({
    source: 'cloudflare',
    receipt: { commandId: KEY, shareId: null, cartVersion: 2, expiresAt: null },
    share: null
  })
  expect(
    sqlite
      .prepare('SELECT customer_id,name,is_default FROM customer_favorite_lists WHERE id=?')
      .get(result.receipt.listId)
  ).toEqual({ customer_id: CUSTOMER, name: body.name, is_default: 0 })
  expect(
    sqlite.prepare('SELECT variant_id,quantity FROM customer_favorite_items WHERE list_id=?').all(result.receipt.listId)
  ).toEqual([{ variant_id: 'v-1-1', quantity: 2 }])
  expect(inventory()).toEqual(before)
  expect(sqlite.prepare('SELECT * FROM carts WHERE id=?').get(access.cartId)).toEqual(cartBefore)
})
it('creates sharing only on explicit request and issues a separate 24h HMAC capability, never the cart bearer', async () => {
  const now = utc()
  const result = cartSnapshotResponseSchema.parse(
    await saveD1CartSnapshot(database, access, { ...body, createShare: true }, { idempotencyKey: KEY, now })
  )
  expect(result.share).not.toBeNull()
  expect(result.share!.token).not.toBe(access.cartToken)
  expect(Date.parse(result.share!.expiresAt) - Date.parse(now)).toBe(24 * 60 * 60 * 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(access.cartToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`neteco:cart-share:v1\n${result.share!.id}`)
  )
  const expected = Buffer.from(signature).toString('base64url')
  expect(result.share!.token).toBe(expected)
  const publicRead = await resolveD1SharedCart(database, { id: result.share!.id, token: result.share!.token })
  expect(sharedCartResolveResponseSchema.parse(publicRead)).toMatchObject({
    id: result.share!.id,
    items: [{ variantId: 'v-1-1', quantity: 2, available: true, cartVariantId: 11, grossCents: 1000 }]
  })
})
it('replays the exact normalized intent, recovers the same share, and rejects changed content with no second list', async () => {
  const raw = { ...body, createShare: true },
    first = await save(raw)
  expect(await save({ ...raw, name: ` ${body.name} ` })).toEqual(first)
  expect(await readD1CartSnapshotCommand(database, access, KEY, await cartSnapshotIntentHash(raw))).toEqual({
    ...first,
    action: 'create',
    outcome: 'applied'
  })
  await expect(save({ ...raw, createShare: false })).rejects.toMatchObject({ code: 'conflict' })
  expect(sqlite.prepare('SELECT count(*) n FROM customer_favorite_lists WHERE customer_id=?').get(CUSTOMER)).toEqual({
    n: 1
  })
})
it('authorizes the live customer and original cart before replay or receipt release', async () => {
  await save()
  await expect(
    readD1CartSnapshotCommand(database, { ...access, cartToken: 'wrong' }, KEY, await cartSnapshotIntentHash(body))
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_SESSION)
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('returns unknown only for the current owner command and does not disguise SQL outages as unknown', async () => {
  expect(await readD1CartSnapshotCommand(database, access, KEY, await cartSnapshotIntentHash(body))).toEqual({
    source: 'cloudflare',
    outcome: 'unknown',
    receipt: null,
    share: null
  })
  const broken = Object.create(database) as D1Database
  broken.prepare = () => {
    throw new Error('synthetic read failure')
  }
  await expect(
    readD1CartSnapshotCommand(broken, access, KEY, await cartSnapshotIntentHash(body))
  ).rejects.toMatchObject({ code: 'service_unavailable' })
})
it('preserves the shared quantities when the saved favorite list and source cart subsequently change', async () => {
  const created = await save({ ...body, createShare: true })
  sqlite.prepare('UPDATE customer_favorite_items SET quantity=9 WHERE list_id=?').run(created.receipt.listId)
  await setCartLine(database, {
    cartId: access.cartId,
    token: access.cartToken,
    variantId: 'v-1-1',
    quantity: 7,
    expectedVersion: 2,
    idempotencyKey: 'snapshot-later-line',
    correlationId: 'snapshot-test',
    now: utc()
  })
  const read = await resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  expect(read.items[0]?.quantity).toBe(2)
})
it('revalidates catalog publication and never leaks private variant facts through unavailable shared lines', async () => {
  const created = await save({ ...body, createShare: true })
  sqlite.exec("UPDATE variants SET status='draft',cost_net_cents=12345 WHERE id='v-1-1'")
  const read = await resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  expect(read.items).toEqual([{ variantId: 'v-1-1', quantity: 2, available: false, reason: 'variant_unavailable' }])
  expect(JSON.stringify(read)).not.toContain('cost')
  expect(JSON.stringify(read)).not.toContain('buyer@example.invalid')
})
it('revokes sharing monotonically without removing the saved list and recovers revoke without the original cart', async () => {
  const created = await save({ ...body, createShare: true })
  const receipt = await revokeD1CartShare(database, BUYER_CLAIMS, created.share!.id, {}, { idempotencyKey: REVOKE_KEY })
  expect(receipt).toMatchObject({
    source: 'cloudflare',
    commandId: REVOKE_KEY,
    shareId: created.share!.id,
    revoked: true
  })
  expect(
    await readD1CartSnapshotCommand(
      database,
      { claims: BUYER_CLAIMS },
      REVOKE_KEY,
      await cartSnapshotRevokeIntentHash(created.share!.id, {})
    )
  ).toEqual({ source: 'cloudflare', action: 'revoke', outcome: 'applied', receipt, share: null })
  const again = await revokeD1CartShare(
    database,
    BUYER_CLAIMS,
    created.share!.id,
    {},
    { idempotencyKey: deterministicUuid('cart-snapshot-second-revoke') }
  )
  expect(again.revokedAt).toBe(receipt.revokedAt)
  await expect(
    resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  ).rejects.toMatchObject({ code: 'not_found' })
  expect(sqlite.prepare('SELECT id FROM customer_favorite_lists WHERE id=?').get(created.receipt.listId)).toBeDefined()
  expect((await listD1CartSnapshots(database, BUYER_CLAIMS)).items[0]?.revoked).toBe(true)
})
it('fails uniformly for wrong, raw cart, and expired sharing tokens', async () => {
  const created = await save({ ...body, createShare: true })
  for (const token of ['X'.repeat(43), access.cartToken])
    await expect(resolveD1SharedCart(database, { id: created.share!.id, token })).rejects.toMatchObject({
      code: 'not_found'
    })
  await expect(
    resolveD1SharedCart(
      database,
      { id: created.share!.id, token: created.share!.token },
      { now: created.share!.expiresAt }
    )
  ).rejects.toMatchObject({ code: 'not_found' })
})
it('fails the entire save if session authority changes before the actual mutation batch', async () => {
  const observed = Object.create(database) as D1Database
  observed.batch = async (statements) => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_SESSION)
    return database.batch(statements)
  }
  await expect(saveD1CartSnapshot(observed, access, body, { idempotencyKey: KEY })).rejects.toMatchObject({
    code: 'unauthenticated'
  })
  expect(sqlite.prepare('SELECT count(*) n FROM customer_favorite_lists WHERE customer_id=?').get(CUSTOMER)).toEqual({
    n: 0
  })
})
it('rejects stale source-cart versions and private list limits instead of saving a partial basket', async () => {
  await expect(save({ ...body, expectedCartVersion: 1 })).rejects.toMatchObject({ code: 'version_conflict' })
  for (let index = 0; index < 20; index++)
    sqlite
      .prepare(
        'INSERT INTO customer_favorite_lists(id,customer_id,name,is_default,created_at,updated_at) VALUES(?,?,?,0,?,?)'
      )
      .run(deterministicUuid(`snapshot-limit-${index}`), CUSTOMER, `Synthetic list ${index}`, utc(), utc())
  await expect(save()).rejects.toMatchObject({ code: 'limit_reached' })
})
it('keeps explicit share consent and normalized name in the hashed contract without accepting financial fields', async () => {
  expect(cartSnapshotInputSchema.safeParse({ name: body.name, expectedCartVersion: 2 }).success).toBe(false)
  expect(cartSnapshotInputSchema.safeParse({ ...body, price: 1 }).success).toBe(false)
  expect(await cartSnapshotIntentHash(body)).toBe(await cartSnapshotIntentHash({ ...body, name: ` ${body.name} ` }))
  expect(await cartSnapshotIntentHash(body)).not.toBe(await cartSnapshotIntentHash({ ...body, createShare: true }))
  for (const name of ['\nname', 'name\t', 'name\u007f', 'name\u0085', 'name\u2028', 'name\u2029'])
    expect(cartSnapshotInputSchema.safeParse({ ...body, name }).success).toBe(false)
})
it('invalidates a link when its saved favorite list is deleted without deleting or resurrecting the original receipt', async () => {
  const created = await save({ ...body, createShare: true })
  sqlite.prepare('DELETE FROM customer_favorite_lists WHERE id=?').run(created.receipt.listId)
  await expect(
    resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  ).rejects.toMatchObject({ code: 'not_found' })
  expect((await listD1CartSnapshots(database, BUYER_CLAIMS)).items).toEqual([])
  const recovered = await readD1CartSnapshotCommand(
    database,
    access,
    KEY,
    await cartSnapshotIntentHash({ ...body, createShare: true })
  )
  expect(recovered).toMatchObject({ outcome: 'applied', receipt: created.receipt, share: created.share })
  expect(
    sqlite.prepare('SELECT id FROM customer_favorite_lists WHERE id=?').get(created.receipt.listId)
  ).toBeUndefined()
})
it('bounds the list by current named lists rather than exhausting its capacity after twenty historical commands', async () => {
  for (let index = 0; index < 21; index++) {
    const created = await save(
      { ...body, name: `Historical snapshot ${index}` },
      deterministicUuid(`historical-cart-snapshot-${index}`)
    )
    sqlite.prepare('DELETE FROM customer_favorite_lists WHERE id=?').run(created.receipt.listId)
  }
  const current = await save()
  expect((await listD1CartSnapshots(database, BUYER_CLAIMS)).items).toEqual([
    { receipt: current.receipt, revoked: false }
  ])
})
it('projects canonical out of stock without backorder and allows it only when the real variant permits backorders', async () => {
  const created = await save({ ...body, createShare: true })
  sqlite.exec("UPDATE inventory_balances SET physical_quantity=0,blocked_quantity=0 WHERE variant_id='v-1-1'")
  const unavailable = await resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  expect(unavailable.items).toEqual([{ variantId: 'v-1-1', quantity: 2, available: false, reason: 'out_of_stock' }])
  sqlite.exec("UPDATE variants SET backorder_allowed=1 WHERE id='v-1-1'")
  const available = await resolveD1SharedCart(database, { id: created.share!.id, token: created.share!.token })
  expect(available.items[0]).toMatchObject({ available: true, reason: null, quantity: 2 })
})
it('does not release the original customer list after a live identity is rebound to a different active customer', async () => {
  await save()
  const other = deterministicUuid('cart-snapshot-rebound-customer'),
    now = utc()
  sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(other, now, now)
  const observed = Object.create(database) as D1Database
  observed.prepare = (sql) => {
    const statement = database.prepare(sql),
      wrapped = Object.create(statement) as D1PreparedStatement
    wrapped.bind = (...values) => {
      const bound = statement.bind(...values),
        result = Object.create(bound) as D1PreparedStatement
      result.all = async <T = Record<string, unknown>>() => {
        const rows = await bound.all<T>()
        if (sql.includes('s.revoked_at,s.id actual_share_id'))
          sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(other, BUYER)
        return rows
      }
      return result
    }
    return wrapped
  }
  await expect(listD1CartSnapshots(observed, BUYER_CLAIMS)).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('does not release earlier public names or prices when publication changes before the final coherent capability/catalog read', async () => {
  const created = await save({ ...body, createShare: true })
  const observed = Object.create(database) as D1Database
  let batches = 0
  observed.batch = async (statements) => {
    if (++batches === 2) sqlite.exec("UPDATE variants SET status='draft' WHERE id='v-1-1'")
    return database.batch(statements)
  }
  await expect(
    resolveD1SharedCart(observed, { id: created.share!.id, token: created.share!.token })
  ).rejects.toMatchObject({ code: 'service_unavailable' })
})
it('rolls back the command, list and share when a real favorite-item insert fails inside the mutation batch', async () => {
  sqlite.exec(
    "CREATE TRIGGER synthetic_snapshot_item_failure BEFORE INSERT ON customer_favorite_items BEGIN SELECT RAISE(ABORT,'synthetic_item_failure'); END"
  )
  await expect(save({ ...body, createShare: true })).rejects.toMatchObject({ code: 'service_unavailable' })
  for (const table of [
    'customer_cart_snapshot_commands',
    'customer_cart_shares',
    'customer_favorite_lists',
    'customer_favorite_items'
  ])
    expect(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 })
})
