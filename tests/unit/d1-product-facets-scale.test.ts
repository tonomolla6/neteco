import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listPublishedProducts } from '../../workers/catalog/products'
import { categoryCommandFixture } from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

describe('bounded fixed product facet aggregates', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: Array.from({ length: 6 }, (_, i) => `p-${i + 1}`)
    })
    sqlite.limits.variableNumber = 100
    sqlite.limits.exprDepth = 100
    sqlite.limits.likePatternLength = 50
    sqlite.limits.sqlLength = 100000
  })
  afterEach(() => sqlite.close())

  it.each(['withdraw off-page contributor', 'change page price and name'])(
    'returns one complete snapshot despite %s immediately after the first data batch',
    async (race) => {
      const query = { page: 1, limit: 1, sort: 'name' as const, facets: true }
      const baseline = await listPublishedProducts(database, query)
      let batches = 0
      const raced = new Proxy(database, {
        get(target, key) {
          if (key === 'batch')
            return async <T>(statements: D1PreparedStatement[]) => {
              const result = await target.batch<T>(statements)
              if (++batches === 1) {
                if (race === 'withdraw off-page contributor') {
                  expect(baseline!.items[0]!.uuid).not.toBe('p-2')
                  sqlite.prepare("UPDATE products SET status='hidden' WHERE id='p-2'").run()
                } else {
                  sqlite
                    .prepare("UPDATE products SET name='Changed after snapshot' WHERE id=?")
                    .run(baseline!.items[0]!.uuid)
                  sqlite
                    .prepare('UPDATE variants SET price_gross_cents=123456 WHERE product_id=?')
                    .run(baseline!.items[0]!.uuid)
                }
              }
              return result
            }
          const member: unknown = Reflect.get(target, key)
          return typeof member === 'function' ? member.bind(target) : member
        }
      })
      const response = await listPublishedProducts(raced, query)
      expect(response).toEqual(baseline)
      expect(batches).toBe(1)
    }
  )

  function cloneProducts(count: number) {
    const product = sqlite.prepare(
      "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes,regulatory) SELECT ?,?,category_id,brand_id,? ,?,'published',attributes,regulatory FROM products WHERE id='p-2'"
    )
    const variant = sqlite.prepare(
      "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,mpn,status,price_gross_cents) VALUES(?,?,?,'t21','sp1',?,'Unit','SYNTHETIC','published',500)"
    )
    const policy = sqlite.prepare(
      "INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at) SELECT ?,?,policy_id,actor_id,reason,created_at FROM catalog_product_publication_policies WHERE product_id='p-2' ORDER BY seq DESC LIMIT 1"
    )
    const media = sqlite.prepare(
      "INSERT INTO product_media_publications(id,product_id,upload_id,role,title,alt,language,version,valid_from,valid_until,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash) SELECT ?,?,upload_id,role,title,alt,language,version,valid_from,valid_until,scan_receipt_id,rights_decision_id,actor_id,created_at,?,payload_hash FROM product_media_publications WHERE product_id='p-2' AND role='main' AND variant_id IS NULL"
    )
    for (let i = 0; i < count; i++) {
      const id = `fixed-contributor-${i}`
      product.run(id, 10000 + i, `ZZ contributor ${i}`, id)
      variant.run(`${id}-variant`, 20000 + i, id, id)
      policy.run(testUuid(), id)
      media.run(testUuid(), id, testUuid())
    }
  }

  it('preserves the legacy bounded public page limit of 1000 for internal callers', async () => {
    cloneProducts(1001)
    const outcome = await listPublishedProducts(database, { page: 1, limit: 1001, sort: 'name' }).then(
      () => null,
      (error: Error) => error.message
    )
    expect(outcome).toBe('invalid_media_product_ids')
  })

  it('aggregates more than 1000 public contributors without exporting their IDs or rows', async () => {
    cloneProducts(1001)
    const batches: Array<Array<{ sql: string; rows: number }>> = []
    const prepared = new WeakMap<object, string>()
    const tracked = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(100000)
            const statement = target.prepare(sql),
              bind = statement.bind.bind(statement)
            prepared.set(statement, sql)
            statement.bind = (...parameters: unknown[]) => {
              expect(parameters.length).toBeLessThanOrEqual(100)
              const bound = bind(...parameters)
              prepared.set(bound, sql)
              return bound
            }
            return statement
          }
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]) => {
            const result = await target.batch<T>(statements)
            batches.push(
              statements.map((statement, index) => ({
                sql: prepared.get(statement) ?? '',
                rows: result[index]?.results.length ?? 0
              }))
            )
            return result
          }
        const member: unknown = Reflect.get(target, key)
        return typeof member === 'function' ? member.bind(target) : member
      }
    })
    const response = await listPublishedProducts(tracked, { page: 1, limit: 1, sort: 'name', facets: true })
    expect(response!.total).toBeGreaterThan(1000)
    expect(response!.facets!.brands.reduce((sum, item) => sum + item.n, 0)).toBe(response!.total)
    const facets = batches.at(-1)!
    expect(facets).toHaveLength(14)
    expect(batches).toHaveLength(1)
    expect(facets.slice(2, 12).every((statement) => statement.rows < 100)).toBe(true)
    expect(facets.slice(2, 12).every((statement) => /GROUP BY|MIN\(/i.test(statement.sql))).toBe(true)
    // The added stock projection is one scalar aggregate, never contributor IDs.
    expect(facets[12]!.rows).toBe(1)
    expect(facets[12]!.sql).toMatch(/SELECT count\(\*\) AS n FROM facet_products/)
    expect(facets.every((statement) => !/json_group_array\(DISTINCT p\.id\)/.test(statement.sql))).toBe(true)
  })

  it('omits an off-page contributor withdrawn immediately before the single response snapshot', async () => {
    let changed = false
    const tracked = new Proxy(database, {
      get(target, key) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]) => {
            changed = true
            sqlite.prepare("UPDATE products SET status='hidden' WHERE id='p-2'").run()
            return target.batch<T>(statements)
          }
        const member: unknown = Reflect.get(target, key)
        return typeof member === 'function' ? member.bind(target) : member
      }
    })
    const initial = await listPublishedProducts(database, { page: 1, limit: 1, sort: 'name', facets: true })
    expect(initial!.items[0]!.uuid).not.toBe('p-2')
    const response = await listPublishedProducts(tracked, { page: 1, limit: 1, sort: 'name', facets: true })
    expect(changed).toBe(true)
    expect(response!.total).toBe(initial!.total - 1)
    expect(response!.facets!.brands.reduce((sum, item) => sum + item.n, 0)).toBe(initial!.total - 1)
  })
})
