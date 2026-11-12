import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { updateD1CatalogRelations } from '../../workers/catalog/catalog-relations'
import { readD1ProductDetailExtras, ProductDetailExtrasError } from '../../workers/catalog/product-detail-extras'
import { productDetailExtrasSchema } from '../../shared/product-detail-extras'
import { testNow } from '../support/deterministic'

const actor = '10000000-0000-4000-8000-000000000146'
const claims = { identityId: actor, sessionId: '20000000-0000-4000-8000-000000000146', sessionVersion: 1 }
let sqlite: DatabaseSync,
  database: D1Database,
  counter = 0
const query = (
  slug = 'producto-1',
  sort: 'relevance' | 'price' | 'availability' = 'relevance',
  availableOnly = false
) => ({
  slug,
  sort,
  availableOnly
})
async function relate(
  relations: Array<{ targetProductId: number; kind: 'substitute' | 'compatible' | 'accessory' | 'equivalent' }>
) {
  await updateD1CatalogRelations(
    database,
    claims,
    1,
    { expectedVersion: 0, relations, reason: 'Synthetic technical rule review', reviewReference: 'TECH-REVIEW-146' },
    { idempotencyKey: `30000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` }
  )
}
function pickup(active = 1) {
  sqlite.exec(`INSERT INTO shipping_zones(id,code,name,kind,active,created_at) VALUES('z-pick','PICK','Recogida','warehouse_pickup',${active},'2026-08-12T00:00:00Z');
   INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
   VALUES('r-pick','z-pick','pickup','parcel',0,2100,0,1,1,1,'2026-08-12T00:00:00Z')`)
}
function paidOrder(id: string, variants: number[]) {
  variants.forEach((product, index) => {
    sqlite
      .prepare(
        `INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
       VALUES(?,?,?,?,?,1,500,413,87,500,2100,'pv','loc-main','2026-08-12T00:00:00Z')`
      )
      .run(id, index, `v-${product}-1`, `SKU-${product}-1`, `Producto ${product}`)
  })
  sqlite
    .prepare(`INSERT INTO order_payment_states(order_id,status,updated_at) VALUES(?, 'paid','2026-08-12T00:00:00Z')`)
    .run(id)
}
beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  database = d1OverSqlite(sqlite)
  await database.batch(
    splitDemoSql(
      await readFile(new URL('../../db/d1/migrations/0076_catalog_relations.sql', import.meta.url), 'utf8')
    ).map((sql) => database.prepare(sql))
  )
  seedInventoryFixture(sqlite)
  const past = new Date(testNow() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const future = new Date(testNow() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  sqlite
    .prepare(
      `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'extras-editor@example.invalid','synthetic-not-login',?,'active',?,?)`
    )
    .run(actor, past, past, past)
  sqlite.exec(`INSERT INTO roles VALUES ('extras_editor','Editor','Synthetic');
    INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic');
    INSERT INTO role_permissions VALUES ('extras_editor','catalog.write');`)
  sqlite
    .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'extras_editor',?)`)
    .run(actor, past)
  sqlite
    .prepare(
      `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)`
    )
    .run(claims.sessionId, actor, past, future)
  await provisionPublicationValidityFixture(database, { productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'] })
})
afterEach(() => sqlite.close())

describe('product detail extras on the real D1 SQLite adapter', () => {
  it('returns availability of the single warehouse and empty relations for a product without curation', async () => {
    const result = productDetailExtrasSchema.parse(await readD1ProductDetailExtras(database, query()))
    expect(result.alternatives).toEqual([])
    expect(result.complements).toEqual([])
    expect(result.warehouse).toEqual({ single: true, pickupEnabled: false })
    expect(result.availability).toEqual([
      { variantId: 11, sku: 'SKU-1-1', status: 'in_stock', sellable: 24, pickupAvailable: false }
    ])
    expect(result.notice).toMatch(/no garantizan compatibilidad/)
  })
  it('splits reviewed substitutes/equivalents from complements and keeps curated order', async () => {
    await relate([
      { targetProductId: 3, kind: 'equivalent' },
      { targetProductId: 2, kind: 'substitute' },
      { targetProductId: 6, kind: 'accessory' },
      { targetProductId: 4, kind: 'compatible' }
    ])
    const result = productDetailExtrasSchema.parse(await readD1ProductDetailExtras(database, query()))
    expect(result.alternatives.map((a) => [a.productId, a.kind, a.reviewed])).toEqual([
      [3, 'equivalent', true],
      [2, 'substitute', true]
    ])
    expect(result.complements.map((c) => [c.productId, c.kind, c.basis])).toEqual([
      [6, 'accessory', 'curated'],
      [4, 'compatible', 'curated']
    ])
    expect(result.alternatives[0]).toMatchObject({
      minPrice: 500,
      formats: 1,
      brand: 'NETECO',
      availability: 'in_stock'
    })
  })
  it('never infers alternatives without a curated relation (same category is not enough)', async () => {
    const result = await readD1ProductDetailExtras(database, query('producto-2'))
    expect(result.alternatives).toEqual([])
  })
  it('classifies low stock and backorder from live sellable stock', async () => {
    await relate([
      { targetProductId: 4, kind: 'substitute' },
      { targetProductId: 5, kind: 'substitute' }
    ])
    sqlite.exec("UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-5-1'")
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.alternatives.map((a) => [a.productId, a.availability])).toEqual([
      [4, 'low_stock'],
      [5, 'backorder']
    ])
  })
  it('active reservations reduce availability (consistent reservation)', async () => {
    sqlite.exec(`INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at)
      VALUES('res-1','res-1','${'a'.repeat(64)}','reserved','corr','2999-01-01T00:00:00Z','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z');
      INSERT INTO inventory_reservation_lines(reservation_id,variant_id,location_id,quantity) VALUES('res-1','v-1-1','loc-main',20)`)
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.availability[0]).toMatchObject({ sellable: 4, status: 'low_stock' })
  })
  it('availableOnly drops out of stock alternatives; sort by price and availability are stable', async () => {
    await relate([
      { targetProductId: 2, kind: 'substitute' },
      { targetProductId: 3, kind: 'substitute' },
      { targetProductId: 4, kind: 'equivalent' }
    ])
    sqlite.exec(`UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-2-1';
      UPDATE variants SET price_gross_cents=300 WHERE id='v-4-1'`)
    const all = await readD1ProductDetailExtras(database, query())
    expect(all.alternatives.map((a) => [a.productId, a.availability])).toEqual([
      [2, 'out_of_stock'],
      [3, 'in_stock'],
      [4, 'low_stock']
    ])
    const only = await readD1ProductDetailExtras(database, query('producto-1', 'relevance', true))
    expect(only.alternatives.map((a) => a.productId)).toEqual([3, 4])
    expect(
      (await readD1ProductDetailExtras(database, query('producto-1', 'price'))).alternatives.map((a) => a.productId)
    ).toEqual([4, 2, 3])
    expect(
      (await readD1ProductDetailExtras(database, query('producto-1', 'availability'))).alternatives.map(
        (a) => a.productId
      )
    ).toEqual([3, 4, 2])
  })
  it('never hides hazard information of the source or of alternatives', async () => {
    await relate([{ targetProductId: 2, kind: 'substitute' }])
    sqlite.exec(
      `UPDATE products SET regulatory=json_set(regulatory,'$.signalWord','Peligro','$.hazardStatements',json('["H314 Provoca quemaduras graves"]')) WHERE id IN ('p-1','p-2')`
    )
    const result = await readD1ProductDetailExtras(database, query('producto-1', 'relevance', true))
    expect(result.hazard).toEqual({
      signalWord: 'Peligro',
      hazardStatements: ['H314 Provoca quemaduras graves'],
      hasHazardData: true
    })
    expect(result.alternatives[0]!.hazard).toEqual(result.hazard)
  })
  it('malformed regulatory data does not hide the item and reports no hazard data explicitly', async () => {
    await relate([{ targetProductId: 2, kind: 'substitute' }])
    sqlite.exec(`UPDATE products SET regulatory=json_set(regulatory,'$.hazardStatements',json('[1,2]')) WHERE id='p-2'`)
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.alternatives[0]!.hazard).toEqual({ signalWord: null, hazardStatements: [], hasHazardData: false })
  })
  it('omits unpublished targets and returns not_found for an unpublished or unknown source', async () => {
    await relate([{ targetProductId: 2, kind: 'substitute' }])
    sqlite.exec("UPDATE products SET status='hidden' WHERE id='p-2'")
    expect((await readD1ProductDetailExtras(database, query())).alternatives).toEqual([])
    await expect(readD1ProductDetailExtras(database, query('no-existe'))).rejects.toMatchObject({ code: 'not_found' })
    sqlite.exec("UPDATE products SET status='hidden' WHERE id='p-1'")
    await expect(readD1ProductDetailExtras(database, query())).rejects.toBeInstanceOf(ProductDetailExtrasError)
  })
  it('pickup requires an active warehouse_pickup rate and real stock', async () => {
    pickup()
    sqlite.exec("UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-5-1'")
    await relate([{ targetProductId: 5, kind: 'substitute' }])
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.warehouse).toEqual({ single: true, pickupEnabled: true })
    expect(result.availability[0]!.pickupAvailable).toBe(true)
    expect(result.alternatives[0]).toMatchObject({ availability: 'backorder', pickupAvailable: false })
  })
  it('disabled pickup zone disables pickup everywhere', async () => {
    pickup(0)
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.warehouse.pickupEnabled).toBe(false)
    expect(result.availability[0]!.pickupAvailable).toBe(false)
  })
  it('with more than one active warehouse there is no availability claim (no multi-warehouse selector)', async () => {
    pickup()
    sqlite.exec(
      `INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('loc-2','ALM-2','Otro','warehouse',1,'2026-08-12T00:00:00Z')`
    )
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.warehouse).toEqual({ single: false, pickupEnabled: false })
    expect(result.availability[0]).toMatchObject({ status: 'unavailable', sellable: 0, pickupAvailable: false })
  })
  it('adds measured co-purchases above support and confidence only, from paid orders only', async () => {
    sqlite.exec('PRAGMA foreign_keys=OFF')
    paidOrder('o1', [1, 6])
    paidOrder('o2', [1, 6, 4])
    paidOrder('o3', [1, 6, 4])
    paidOrder('o4', [1, 3])
    sqlite
      .prepare(
        "INSERT INTO order_lines SELECT 'o5',line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at FROM order_lines WHERE order_id='o1'"
      )
      .run()
    sqlite.exec(
      "INSERT INTO order_payment_states(order_id,status,updated_at) VALUES('o5','failed','2026-08-12T00:00:00Z')"
    )
    const result = productDetailExtrasSchema.parse(await readD1ProductDetailExtras(database, query()))
    expect(result.complements).toEqual([
      expect.objectContaining({
        productId: 6,
        basis: 'co_purchase',
        kind: 'co_purchase',
        support: 3,
        confidencePermille: 750
      })
    ])
  })
  it('curated complements win over co-purchase duplicates and substitutes are never offered as complements', async () => {
    await relate([
      { targetProductId: 6, kind: 'accessory' },
      { targetProductId: 4, kind: 'substitute' }
    ])
    sqlite.exec('PRAGMA foreign_keys=OFF')
    for (const id of ['o1', 'o2', 'o3']) paidOrder(id, [1, 6, 4])
    const result = await readD1ProductDetailExtras(database, query())
    expect(result.complements.map((c) => [c.productId, c.basis])).toEqual([[6, 'curated']])
    expect(result.alternatives.map((a) => a.productId)).toEqual([4])
  })
  it('co-purchase never offers unpublished products or the product itself', async () => {
    sqlite.exec('PRAGMA foreign_keys=OFF')
    for (const id of ['o1', 'o2', 'o3']) paidOrder(id, [1, 6])
    sqlite.exec("UPDATE products SET status='hidden' WHERE id='p-6'")
    expect((await readD1ProductDetailExtras(database, query())).complements).toEqual([])
  })
  it('does not leak costs, order ids, emails or review references', async () => {
    await relate([{ targetProductId: 2, kind: 'substitute' }])
    sqlite.exec('PRAGMA foreign_keys=OFF')
    for (const id of ['o1', 'o2', 'o3']) paidOrder(id, [1, 6])
    const text = JSON.stringify(await readD1ProductDetailExtras(database, query()))
    expect(text).not.toMatch(/TECH-REVIEW|cost_net|o1|example\.invalid|loc-main|reason/)
  })
  it('rejects invalid input and surfaces database failures as service_unavailable', async () => {
    await expect(readD1ProductDetailExtras(database, query('Bad Slug'))).rejects.toMatchObject({
      code: 'invalid_input'
    })
    sqlite.exec('DROP TABLE order_payment_states')
    await expect(readD1ProductDetailExtras(database, query())).rejects.toMatchObject({ code: 'service_unavailable' })
  })
  it('uses a bounded number of statements (no N+1)', async () => {
    await relate([
      { targetProductId: 2, kind: 'substitute' },
      { targetProductId: 3, kind: 'equivalent' },
      { targetProductId: 4, kind: 'accessory' },
      { targetProductId: 5, kind: 'compatible' }
    ])
    let prepared = 0
    const counting = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            prepared++
            return target.prepare(sql)
          }
        return Reflect.get(target, property, receiver)
      }
    })
    await readD1ProductDetailExtras(counting, query())
    expect(prepared).toBeLessThanOrEqual(6)
  })
})
