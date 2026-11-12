import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import worker from '../../workers/canary'
import { previewQuickOrder, type QuickOrderRead } from '../../shared/quick-order'
import { renderD1CategorySeed, stableUuid } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid, testNow } from '../support/deterministic'

// Actual canary dispatcher + native workerd D1, not fabricated public DTOs.
// Fixture writes below are deliberately outside every measured read interval.
// This does not claim browser acceptance or execution of the compiled shop bundle.
describe('quick order against real public HTTP contracts and workerd D1', () => {
  const productId = stableUuid('product:1'),
    variantId = stableUuid('variant:1:1')
  const sku = 'QUICK-NATIVE-EXACT-001',
    ean = '8412345678905'
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  let runtime: Miniflare, database: D1Database, readOnly: D1Database, slug: string
  let writes = 0
  const paths: string[] = [],
    queries: string[] = []
  const native = new WeakMap<object, D1PreparedStatement>()
  const checkMeta = (result: D1Result) => {
    writes += result.meta.rows_written
    return result
  }
  function statement(sql: string, original: D1PreparedStatement): D1PreparedStatement {
    const wrapped = {
      bind(...args: unknown[]) {
        return statement(sql, original.bind(...args))
      },
      first: original.first.bind(original),
      all: async () => checkMeta(await original.all()),
      raw: original.raw.bind(original),
      run: async () => {
        throw new Error('unexpected_mutation_method')
      }
    } as D1PreparedStatement
    native.set(wrapped, original)
    return wrapped
  }
  const read: QuickOrderRead = async (path, options) => {
    expect(options).toMatchObject({ method: 'GET', cache: 'no-store', retry: 0 })
    expect(path === '/api/search' || /^\/api\/products\/[a-z0-9-]+$/.test(path)).toBe(true)
    paths.push(path)
    const url = new URL(path, 'https://quick-order.invalid')
    if (options.query) url.search = new URLSearchParams(options.query).toString()
    const response = await worker.fetch(new Request(url, { method: 'GET' }), {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false',
      REDSYS_ENABLED: 'false',
      DB: readOnly
    } as unknown as CloudflareEnv)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    if (!response.ok) throw Object.assign(new Error('public_http_rejected'), { statusCode: response.status })
    return response.json()
  }
  const snapshot = async () =>
    Promise.all([
      database.prepare('SELECT * FROM products WHERE id=?').bind(productId).all(),
      database.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').bind(productId).all(),
      database
        .prepare(
          'SELECT * FROM variant_price_versions WHERE variant_id IN (SELECT id FROM variants WHERE product_id=?) ORDER BY id'
        )
        .bind(productId)
        .all(),
      database
        .prepare(
          'SELECT * FROM inventory_balances WHERE variant_id IN (SELECT id FROM variants WHERE product_id=?) ORDER BY variant_id,location_id'
        )
        .bind(productId)
        .all(),
      ...['carts', 'cart_lines', 'cart_commands', 'orders', 'order_lines'].map((table) =>
        database.prepare(`SELECT * FROM ${table} ORDER BY 1 LIMIT 100`).all()
      )
    ]).then((results) => results.map((result) => result.results))
  async function measured(action: () => Promise<void>) {
    const before = await snapshot(),
      beforeWrites = writes
    await action()
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(beforeWrites)
    expect(outbound).not.toHaveBeenCalled()
    expect(queries.length).toBeGreaterThan(0)
    expect(paths.every((path) => path === '/api/search' || path.startsWith('/api/products/'))).toBe(true)
  }
  beforeAll(async () => {
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'quick-order-native-contract',
        script: 'export default {fetch(){return new Response("isolated")}}',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000097' },
        outboundService: outbound
      })
    )
    database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const execute = async (sql: string) => {
      const statements = splitDemoSql(sql)
      for (let i = 0; i < statements.length; i += 50)
        await database.batch(statements.slice(i, i + 50).map((text) => database.prepare(text)))
    }
    for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort())
      await execute(await readFile(join('db/d1/migrations', name), 'utf8'))
    for (const sql of [renderD1CategorySeed(), renderD1ProductSeed(), renderD1InventorySeed()]) await execute(sql)
    await database
      .prepare('UPDATE variants SET sku=?,ean=?,minimum_quantity=2,quantity_increment=2,maximum_quantity=10 WHERE id=?')
      .bind(sku, ean, variantId)
      .run()
    const instant = new Date(testNow() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await database
      .prepare(
        "INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at) VALUES (?,?,1210,'[{\"minimumQuantity\":6,\"unitGrossCents\":1089}]',?,'approved','Synthetic native quick order price',?)"
      )
      .bind(testUuid(), variantId, instant, instant)
      .run()
    await provisionPublicationValidityFixture(database, {
      productIds: [productId],
      now: '2020-01-01T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    slug = (await database.prepare('SELECT slug FROM products WHERE id=?').bind(productId).first<{ slug: string }>())!
      .slug
    readOnly = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            queries.push(sql)
            expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i)
            expect(sql).not.toMatch(
              /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i
            )
            return statement(sql, target.prepare(sql))
          }
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements.map((item) => native.get(item)!))
            return results.map((result) => checkMeta(result))
          }
        return Reflect.get(target, key)
      }
    })
  }, 30_000)
  afterAll(async () => {
    await runtime?.dispose()
  })

  it('resolves actual SKU and EAN with current MOQ, increment, volume tier and 21% IVA; dedups detail reads', async () => {
    await measured(async () => {
      const skuRows = await previewQuickOrder([{ reference: sku, quantity: 6 }], read)
      expect(skuRows[0]?.status, JSON.stringify({ rows: skuRows, paths, queries: queries.length })).toBe('ready')
      expect(skuRows[0]).toMatchObject({
        status: 'ready',
        slug,
        variant: {
          uuid: variantId,
          id: 1,
          sku,
          ean,
          minimumQuantity: 2,
          quantityIncrement: 2,
          maximumQuantity: 10,
          taxRateBasisPoints: 2100
        },
        unitGrossCents: 1089,
        grossCents: 6534,
        netCents: 5400,
        taxCents: 1134
      })
      expect((await previewQuickOrder([{ reference: ean, quantity: 2 }], read))[0]).toMatchObject({
        status: 'ready',
        variant: { uuid: variantId },
        unitGrossCents: 1210
      })
      const start = paths.length
      const duplicates = await previewQuickOrder(
        [
          { reference: sku, quantity: 2 },
          { reference: ean, quantity: 2 }
        ],
        read
      )
      expect(duplicates.every((row) => row.status === 'error')).toBe(true)
      expect(paths.slice(start).filter((path) => path === `/api/products/${slug}`)).toHaveLength(1)
    })
  }, 30_000)
  it('rejects actual unknown/fuzzy references and quantities outside MOQ/increment/maximum without any cart operation', async () => {
    await measured(async () => {
      for (const reference of ['QUICK-NATIVE-NOT-PRESENT', sku.slice(0, -1)])
        expect((await previewQuickOrder([{ reference, quantity: 2 }], read))[0]).toMatchObject({ status: 'error' })
      for (const quantity of [1, 3, 12])
        expect((await previewQuickOrder([{ reference: sku, quantity }], read))[0]).toMatchObject({ status: 'error' })
    })
  }, 30_000)
  it('rejects publication withdrawn after a real search before detail, and an already withdrawn lookup, never an empty success', async () => {
    let reachedDetail = false
    const withdrawing: QuickOrderRead = async (path, options) => {
      if (path === `/api/products/${slug}`) {
        reachedDetail = true
        // Explicit fixture event, before the measured read interval below.
        await database.prepare("UPDATE products SET status='hidden' WHERE id=?").bind(productId).run()
      }
      return read(path, options)
    }
    try {
      const rows = await previewQuickOrder([{ reference: sku, quantity: 2 }], withdrawing)
      expect(reachedDetail).toBe(true)
      expect(rows[0]).toMatchObject({ status: 'error', message: expect.stringContaining('consultar') })
      await measured(async () => {
        expect((await previewQuickOrder([{ reference: sku, quantity: 2 }], read))[0]).toMatchObject({
          status: 'error',
          message: expect.stringContaining('No encontramos')
        })
      })
      expect(writes).toBe(0)
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      await database.prepare("UPDATE products SET status='published' WHERE id=?").bind(productId).run()
    }
  }, 30_000)
})
