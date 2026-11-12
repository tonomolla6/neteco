import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { listPublishedProducts, type ProductQuery } from '../../workers/catalog/products'
import worker from '../../workers/canary'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const instant = '2026-08-20T00:00:00Z'
const query = (overrides: Partial<ProductQuery> = {}): ProductQuery => ({
  page: 1,
  limit: 12,
  sort: 'default',
  ...overrides
})

describe('D1 catalog filters and self-excluding facets', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    // Migrations are already applied; all fixture and caller SQL now runs
    // under the actual D1 statement limits, not SQLite's larger defaults.
    sqlite.limits.variableNumber = 100
    sqlite.limits.exprDepth = 100
    applyGeneratedSeed(sqlite, renderD1CategorySeed())
    applyGeneratedSeed(sqlite, renderD1ProductSeed())
    database = d1OverSqlite(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: sqlite
        .prepare("SELECT id FROM products WHERE status='published'")
        .all()
        .map((row) => String(row.id)),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    sqlite.limits.functionArg = 32
    sqlite.limits.likePatternLength = 50
    sqlite.limits.sqlLength = 100000
  })
  afterEach(() => sqlite.close())

  function selectedProductFixture(withSize = false) {
    const product = sqlite
      .prepare(
        `SELECT p.id, p.name, c.slug AS category, b.name AS brand FROM products p
         JOIN categories c ON c.id=p.category_id JOIN brands b ON b.id=p.brand_id WHERE p.legacy_id=20`
      )
      .get()
    if (
      !product ||
      typeof product.id !== 'string' ||
      typeof product.name !== 'string' ||
      typeof product.category !== 'string' ||
      typeof product.brand !== 'string'
    )
      throw new Error('Missing explicit selected product fixture')
    const variant = sqlite
      .prepare("SELECT id FROM variants WHERE product_id=? AND status='published' ORDER BY id LIMIT 1")
      .get(product.id)
    if (!variant || typeof variant.id !== 'string') throw new Error('Missing explicit selected variant fixture')
    sqlite
      .prepare('UPDATE products SET attributes=? WHERE id=?')
      .run(JSON.stringify({ badges: ['eco'], visual: { type: 'spray', color: '#008800' } }), product.id)
    sqlite
      .prepare('UPDATE variants SET format=?,content_quantity=?,unit_label=?,color=? WHERE id=?')
      .run('50x70 cm · Precorte 20 cm · Color Azul', 0.75, 'L', '#0000ff', variant.id)
    if (withSize)
      sqlite
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
            price_gross_cents,mpn,content_quantity,unit_label,weight_grams)
           SELECT 'synthetic-facet-size-20',900001,product_id,tax_class_id,shipping_profile_id,
            'SYNTHETIC-FACET-SIZE-20','Talla M','published',price_gross_cents,'SYNTHETIC-FACET-SIZE-20',1,'ud',1000
           FROM variants WHERE id=?`
        )
        .run(variant.id)
    return {
      productUuid: product.id,
      variantUuid: variant.id,
      name: product.name,
      category: product.category,
      brand: product.brand
    }
  }

  function trackedDatabase() {
    const statements: Array<{ sql: string; parameters: readonly unknown[] }> = []
    const nativePrepare = database.prepare.bind(database)
    const tracked = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) =>
            new Proxy(nativePrepare(sql), {
              get(statement, member) {
                if (member === 'bind')
                  return (...parameters: unknown[]) => {
                    statements.push({ sql, parameters })
                    return statement.bind(...parameters)
                  }
                const value: unknown = Reflect.get(statement, member)
                return typeof value === 'function' ? value.bind(statement) : value
              }
            })
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return { database: tracked, statements }
  }

  function fiftyValues(last: string, filler: (index: number) => string, separator = ',') {
    return [...Array.from({ length: 49 }, (_, index) => filler(index)), last].join(separator)
  }

  function allFilters(selected: ReturnType<typeof selectedProductFixture>): Partial<ProductQuery> {
    return {
      category: selected.category,
      search: selected.name,
      brand: selected.brand,
      badge: 'eco',
      envase: 'spray',
      talla: 'M',
      capacidad: '0.75-L',
      color: 'Azul',
      medida: '50x70 cm',
      acabado: 'Precortado',
      priceMin: '0',
      priceMax: '1000000',
      facets: true
    }
  }

  it('returns all UI facet keys with product-deduplicated counts and omits them on scroll pages', async () => {
    const first = (await listPublishedProducts(database, query({ facets: true }), { instant }))!
    expect(first.total).toBe(20)
    expect(first.items).toHaveLength(12)
    expect(first.facets).toMatchObject({
      brands: [{ value: 'NETECO', n: 20 }],
      badges: expect.any(Array),
      envases: expect.any(Array),
      tallas: expect.arrayContaining([{ value: 'M', n: expect.any(Number) }]),
      capacidades: expect.any(Array),
      colores: expect.any(Array),
      medidas: expect.any(Array),
      acabados: expect.any(Array),
      price: { min: expect.any(Number), max: expect.any(Number) },
      categories: expect.any(Array)
    })
    expect(first.facets!.tallas.find((item) => item.value === 'M')!.n).toBeLessThanOrEqual(20)
    expect(first.items[0]).toHaveProperty('compareAtPrice')
    const next = (await listPublishedProducts(database, query({ page: 2 }), { instant }))!
    expect(next).not.toHaveProperty('facets')
    expect(next.items).toHaveLength(8)
  })

  it('preserves badge occurrences, ASCII axis classification and Unicode precorte whitespace with duplicate variants', async () => {
    const selected = selectedProductFixture()
    sqlite
      .prepare("UPDATE products SET attributes=json_set(attributes,'$.badges',json(?)) WHERE id=?")
      .run(JSON.stringify(['eco', 'eco', 'Élite']), selected.productUuid)
    const formats = [
      '50x70 cm · Precorte\u00a020 cm · Color Azul',
      '50x70 cm · Precorte\t20 cm · Color Azul',
      '٣٣ cm · Acabado Élite · Color Azul',
      'Color Verde · Color Azul',
      '90 cm · Acabado sin color',
      '100 cm · Color ',
      '110 cm · Color Azul\n',
      '50x70 cm · Precorte 20 cm · Color Azul',
      '60x80 cm · Precorte 20 cm · Color Azul'
    ]
    const insert =
      sqlite.prepare(`INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,mpn,content_quantity,unit_label,weight_grams)
      SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,?,'published',price_gross_cents,?,1,'ud',1000 FROM variants WHERE id=?`)
    formats.forEach((format, index) =>
      insert.run(`axes-parity-${index}`, 910000 + index, `AXES-${index}`, format, `AXES-${index}`, selected.variantUuid)
    )
    const response = await listPublishedProducts(database, query({ search: selected.name, facets: true }), { instant })
    expect(response!.total).toBe(1)
    expect(response!.facets!.badges).toEqual([
      { value: 'eco', n: 2 },
      { value: 'Élite', n: 1 }
    ])
    expect(response!.facets!.medidas).toEqual([
      { value: '50x70 cm', n: 1 },
      { value: '60x80 cm', n: 1 }
    ])
    expect(response!.facets!.acabados).toEqual(
      expect.arrayContaining([
        { value: 'Precortado', n: 1 },
        { value: '٣٣ cm', n: 1 },
        { value: 'Acabado Élite', n: 1 },
        { value: 'Color Verde', n: 1 }
      ])
    )
    expect(response!.facets!.acabados).toHaveLength(4)
  })

  it('chooses the first durable variant ID with a nonempty hex, not the minimum hex or encounter order', async () => {
    const selected = selectedProductFixture()
    const insert =
      sqlite.prepare(`INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,mpn,content_quantity,unit_label,weight_grams,color)
      SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,'Unit · Color Azul','published',price_gross_cents,?,1,'ud',1000,? FROM variants WHERE id=?`)
    insert.run('0002-hex-first-insert', 920002, 'HEX-2', 'HEX-2', '#000000', selected.variantUuid)
    insert.run('0001-hex-first-durable', 920001, 'HEX-1', 'HEX-1', '#ffffff', selected.variantUuid)
    expect(() => insert.run('0000-hex-empty', 920000, 'HEX-0', 'HEX-0', '', selected.variantUuid)).toThrow(/CHECK/)
    insert.run('0000-hex-null', 920003, 'HEX-NULL', 'HEX-NULL', null, selected.variantUuid)
    const response = await listPublishedProducts(database, query({ search: selected.name, facets: true }), { instant })
    expect(response!.facets!.colores).toEqual([{ value: 'Azul', n: 1, hex: '#ffffff' }])
  })

  it('preserves legacy JSON-string arrays/visuals and ignores malformed badge JSON without SQL errors', async () => {
    const selected = selectedProductFixture()
    sqlite
      .prepare('UPDATE products SET attributes=? WHERE id=?')
      .run(
        JSON.stringify({ badges: JSON.stringify(['eco', 'eco']), visual: JSON.stringify({ type: 'spray' }) }),
        selected.productUuid
      )
    const encoded = await listPublishedProducts(database, query({ search: selected.name, facets: true }), { instant })
    expect(encoded!.facets!.badges).toEqual([{ value: 'eco', n: 2 }])
    expect(encoded!.facets!.envases).toEqual([{ value: 'spray', n: 1 }])
    sqlite
      .prepare("UPDATE products SET attributes=json_set(attributes,'$.badges','not-json') WHERE id=?")
      .run(selected.productUuid)
    const malformed = await listPublishedProducts(database, query({ search: selected.name, facets: true }), { instant })
    expect(malformed!.facets!.badges).toEqual([])
  })

  it('sorts unknown sizes explicitly and preserves exact capacity pairs without cross-combinations', async () => {
    const selected = selectedProductFixture()
    const insert =
      sqlite.prepare(`INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,mpn,content_quantity,unit_label,weight_grams)
      SELECT ?,?,product_id,tax_class_id,shipping_profile_id,?,?,'published',price_gross_cents,?,?,?,1000 FROM variants WHERE id=?`)
    ;[
      ['Talla Zeta', 2, 'kg'],
      ['Talla Ágil', 3, 'L'],
      ['Talla M', 2, 'kg'],
      ['Talla XS', 3, 'L']
    ].forEach(([format, units, label], index) =>
      insert.run(
        `size-pair-${index}`,
        930000 + index,
        `PAIR-${index}`,
        format,
        `PAIR-${index}`,
        units,
        label,
        selected.variantUuid
      )
    )
    const response = await listPublishedProducts(database, query({ search: selected.name, facets: true }), { instant })
    expect(response!.facets!.tallas.map((row) => row.value)).toEqual(['XS', 'M', 'Ágil', 'Zeta'])
    expect(response!.facets!.capacidades).toEqual(
      expect.arrayContaining([
        { value: '2-kg', units: 2, label: 'kg', n: 1 },
        { value: '3-L', units: 3, label: 'L', n: 1 }
      ])
    )
    expect(response!.facets!.capacidades.some((row) => row.value === '2-L' || row.value === '3-kg')).toBe(false)
  })

  it('excludes each active filter from its own facet but applies it to the result set', async () => {
    const none = (await listPublishedProducts(database, query({ brand: 'No existe', facets: true }), { instant }))!
    expect(none.total).toBe(0)
    expect(none.facets!.brands).toEqual([{ value: 'NETECO', n: 20 }])
    const sizes = (await listPublishedProducts(database, query({ talla: 'M', facets: true }), { instant }))!
    expect(sizes.total).toBeGreaterThan(0)
    expect(sizes.total).toBeLessThan(20)
    expect(sizes.facets!.tallas.some((facet) => facet.value === 'XS')).toBe(true)
    expect(sizes.facets!.brands[0]!.n).toBe(sizes.total)
    const expensive = (await listPublishedProducts(database, query({ priceMin: '9999', facets: true }), { instant }))!
    expect(expensive.total).toBe(0)
    expect(expensive.facets!.price?.max).toBeLessThan(9999 * 100)
  })

  it('filters badge, container, capacity, color, measurement and finish with parameterized values', async () => {
    const product = sqlite.prepare('SELECT id FROM products WHERE legacy_id = 20').get() as { id: string }
    const variant = sqlite.prepare('SELECT id FROM variants WHERE product_id = ?').get(product.id) as { id: string }
    sqlite
      .prepare('UPDATE products SET attributes = ? WHERE id = ?')
      .run(JSON.stringify({ badges: ['eco'], visual: { type: 'spray', color: '#008800' } }), product.id)
    sqlite
      .prepare('UPDATE variants SET format = ?, content_quantity = ?, unit_label = ?, color = ? WHERE id = ?')
      .run('50x70 cm · Precorte 20 cm · Color Azul', 0.75, 'L', '#0000ff', variant.id)
    const cases: Array<Partial<ProductQuery>> = [
      { badge: 'eco' },
      { envase: 'spray' },
      { capacidad: '0.75-L' },
      { color: 'Azul' },
      { medida: '50x70 cm' },
      { acabado: 'Precortado' }
    ]
    for (const filter of cases) {
      const result = (await listPublishedProducts(database, query(filter), { instant }))!
      expect(result.items.map((item) => item.id)).toContain(20)
    }
    const facets = (await listPublishedProducts(database, query({ facets: true }), { instant }))!.facets!
    expect(facets.badges).toContainEqual({ value: 'eco', n: 1 })
    expect(facets.envases).toContainEqual({ value: 'spray', n: 1 })
    expect(facets.capacidades).toContainEqual({ value: '0.75-L', units: 0.75, label: 'L', n: 1 })
    expect(facets.colores).toContainEqual({ value: 'Azul', n: 1, hex: '#0000ff' })
    expect(facets.medidas).toContainEqual({ value: '50x70 cm', n: 1 })
    expect(facets.acabados).toContainEqual({ value: 'Precortado', n: 1 })
    expect((await listPublishedProducts(database, query({ color: 'A%' }), { instant }))!.total).toBe(0)
  })

  it('uses governed effective prices for price filtering and serves the real HTTP contract', async () => {
    const product = sqlite.prepare('SELECT id FROM products WHERE legacy_id = 20').get() as { id: string }
    const variant = sqlite.prepare('SELECT id FROM variants WHERE product_id = ?').get(product.id) as { id: string }
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id, variant_id, gross_cents, compare_at_gross_cents,
          volume_tiers, valid_from, reason, created_at)
        VALUES ('facet-price', ?, 50000, 60000, '[]', '2026-08-19T00:00:00Z',
          'Precio de prueba para filtro público', '2026-08-19T00:00:00Z')`
      )
      .run(variant.id)
    const direct = (await listPublishedProducts(database, query({ priceMin: '400', facets: true }), { instant }))!
    expect(direct.items.map((item) => item.id)).toEqual([20])
    expect(direct.items[0]).toMatchObject({ minPrice: 50000, compareAtPrice: 60000 })
    const env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    const response = await worker.fetch(new Request('https://neteco.invalid/api/products?price_min=400&facets=1'), env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { total: number; facets: unknown; items: Array<{ id: number }> }
    expect(body.total).toBe(1)
    expect(body.items[0]?.id).toBe(20)
    expect(body.facets).toBeDefined()
  })

  it('"Solo en stock" keeps products with sellable stock, counts them and serves the HTTP flag', async () => {
    sqlite.exec(
      `INSERT INTO inventory_locations (id, code, name, kind, active, created_at)
       VALUES ('loc-stock', 'ALM-STOCK', 'Almacén stock', 'warehouse', 1, '2026-08-12T00:00:00Z')`
    )
    const variantOf = (legacyId: number) =>
      (
        sqlite
          .prepare('SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE p.legacy_id=? ORDER BY v.id')
          .get(legacyId) as { id: string }
      ).id
    const balance = sqlite.prepare(
      `INSERT INTO inventory_balances (variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at)
       VALUES (?, 'loc-stock', ?, ?, 1, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')`
    )
    balance.run(variantOf(20), 5, 0)
    // Physical units that are all blocked are not stock a customer can buy.
    balance.run(variantOf(19), 4, 4)

    const all = (await listPublishedProducts(database, query({ facets: true }), { instant }))!
    expect(all.facets!.inStock).toBe(1)
    const only = (await listPublishedProducts(database, query({ inStock: true, facets: true }), { instant }))!
    expect(only.items.map((item) => item.id)).toEqual([20])
    expect(only.total).toBe(1)
    // Its own facet ignores the flag, like every other facet.
    expect(only.facets!.inStock).toBe(1)

    const env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    const response = await worker.fetch(new Request('https://neteco.invalid/api/products?stock=1&facets=1'), env)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { total: number; items: Array<{ id: number }> }
    expect(body.items.map((item) => item.id)).toEqual([20])
  })

  it('honors capacity position fifty without exceeding the real D1 limits', async () => {
    selectedProductFixture()
    const expected = await listPublishedProducts(database, query({ capacidad: '0.75-L', facets: true }), { instant })
    const result = await listPublishedProducts(
      database,
      query({ capacidad: fiftyValues('0.75-L', (index) => `${1000 + index}-Synthetic`), facets: true }),
      { instant }
    )
    expect(result).toEqual(expected)
    expect(result?.items.map((item) => item.id)).toContain(20)
    expect(sqlite.limits.variableNumber).toBe(100)
    expect(sqlite.limits.exprDepth).toBe(100)
  })

  it('ignores a matching capacity in position fifty-one and still self-excludes its facet', async () => {
    selectedProductFixture()
    const capacity = [...Array.from({ length: 50 }, (_, index) => `${1000 + index}-Synthetic`), '0.75-L'].join(',')
    const result = await listPublishedProducts(database, query({ capacidad: capacity, facets: true }), { instant })
    expect(result?.total).toBe(0)
    expect(result?.items).toEqual([])
    expect(result?.facets?.capacidades).toContainEqual({ value: '0.75-L', units: 0.75, label: 'L', n: 1 })
  })

  it('combines eight fifty-value filters with exact DTO/facets and a maximum of twenty-three bindings', async () => {
    const selected = selectedProductFixture(true)
    const base = allFilters(selected)
    const expected = await listPublishedProducts(database, query(base), { instant })
    const tracked = trackedDatabase()
    const result = await listPublishedProducts(
      tracked.database,
      query({
        ...base,
        brand: fiftyValues(selected.brand, (index) => `Unmatched brand ${index}`),
        badge: fiftyValues('eco', (index) => `unmatched-badge-${index}`),
        envase: fiftyValues('spray', (index) => `unused${'a'.repeat(index + 1)}`),
        talla: fiftyValues('M', (index) => `missing-size-${index}`),
        capacidad: fiftyValues('0.75-L', (index) => `${1000 + index}-Synthetic`),
        color: fiftyValues('Azul', (index) => `MissingColor${index}`),
        medida: fiftyValues('50x70 cm', (index) => `9999x${index} cm`, '|'),
        acabado: fiftyValues('Precortado', (index) => `MissingFinish${index}`)
      }),
      { instant }
    )
    expect(result).toEqual(expected)
    expect(result?.items.map((item) => item.id)).toEqual([20])
    const count = tracked.statements.find((statement) => statement.sql.includes('SELECT count(*) AS total')),
      page = tracked.statements.find((statement) => statement.sql.includes('LIMIT ? OFFSET ?'))
    expect(count).toBeDefined()
    expect(page).toBeDefined()
    // Assert the actual D1 budget, not an optimizer's incidental bind count:
    // the shared synonym search now uses two fewer parameters for the same DTO.
    expect(count!.parameters.length).toBeLessThanOrEqual(21)
    expect(page!.parameters.length).toBeLessThanOrEqual(23)
    expect(Math.max(...tracked.statements.map((statement) => statement.parameters.length))).toBeLessThanOrEqual(23)
  })

  it('keeps fifty duplicate selections from multiplying products or self-excluding facet counts', async () => {
    const selected = selectedProductFixture(true)
    const base = allFilters(selected)
    const expected = await listPublishedProducts(database, query(base), { instant })
    const duplicate = (value: string, separator = ',') => Array<string>(50).fill(value).join(separator)
    const result = await listPublishedProducts(
      database,
      query({
        ...base,
        brand: duplicate(selected.brand),
        badge: duplicate('eco'),
        envase: duplicate('spray'),
        talla: duplicate('M'),
        capacidad: duplicate('0.75-L'),
        color: duplicate('Azul'),
        medida: duplicate('50x70 cm', '|'),
        acabado: duplicate('Precortado')
      }),
      { instant }
    )
    expect(result).toEqual(expected)
    expect(result?.total).toBe(1)
    expect(result?.facets?.badges).toContainEqual({ value: 'eco', n: 1 })
  })

  it('never combines the numeric quantity of one capacity with the unit of another', async () => {
    selectedProductFixture()
    const result = await listPublishedProducts(database, query({ capacidad: '0.75-kg,999-L' }), { instant })
    expect(result?.items.map((item) => item.id)).not.toContain(20)
    const matching = await listPublishedProducts(database, query({ capacidad: '999-kg,00.750-L' }), { instant })
    expect(matching?.items.map((item) => item.id)).toContain(20)
  })

  it('preserves trimming, invalid-value omission and truncation before capacity validation', async () => {
    selectedProductFixture()
    const expected = await listPublishedProducts(database, query({ capacidad: '0.75-L' }), { instant })
    expect(
      await listPublishedProducts(database, query({ capacidad: ' 0.750-L , ..-L,Infinity-L,unknown' }), { instant })
    ).toEqual(expected)
    const unfiltered = await listPublishedProducts(database, query(), { instant })
    expect(
      await listPublishedProducts(
        database,
        query({ capacidad: `${Array<string>(50).fill('..-L').join(',')},0.75-L` }),
        { instant }
      )
    ).toEqual(unfiltered)
    expect(await listPublishedProducts(database, query({ envase: 'spray0' }), { instant })).toEqual(unfiltered)
  })

  it.each([
    ['color', "A%_\\'", "AxY\\'"],
    ['medida', '50%_\\x cm', '50ab\\x cm'],
    ['acabado', "Bordado%_\\'", "Bordadoxy\\'"]
  ] as const)('keeps literal percent, underscore, backslash and quotes in the %s filter', async (key, match, miss) => {
    const selected = selectedProductFixture()
    sqlite
      .prepare('UPDATE variants SET format=? WHERE id=?')
      .run("50%_\\x cm · Bordado%_\\' · Color A%_\\'", selected.variantUuid)
    const tracked = trackedDatabase()
    const result = await listPublishedProducts(tracked.database, query({ [key]: match }), { instant })
    expect(result?.items.map((item) => item.id)).toContain(20)
    expect(
      tracked.statements.some((statement) =>
        statement.parameters.some((parameter) => typeof parameter === 'string' && parameter.includes('\\\\'))
      )
    ).toBe(true)
    expect(
      (await listPublishedProducts(database, query({ [key]: miss }), { instant }))?.items.map((item) => item.id)
    ).not.toContain(20)
  })

  it.each(['Precorte 20 cm', 'Bordado'])(
    'matches the %s branch of mixed Precortado and normal finishes',
    async (finish) => {
      const selected = selectedProductFixture()
      sqlite
        .prepare('UPDATE variants SET format=? WHERE id=?')
        .run(`50x70 cm · ${finish} · Color Azul`, selected.variantUuid)
      const result = await listPublishedProducts(database, query({ acabado: 'Missing, pReCoRtAdO , Bordado' }), {
        instant
      })
      expect(result?.items.map((item) => item.id)).toContain(20)
      expect(
        (await listPublishedProducts(database, query({ acabado: 'Missing' }), { instant }))?.items.map(
          (item) => item.id
        )
      ).not.toContain(20)
    }
  )

  it('binds JSON values containing SQL syntax instead of interpolating them into the statement', async () => {
    const marker = "synthetic'); SELECT private_table; --"
    const tracked = trackedDatabase()
    const result = await listPublishedProducts(tracked.database, query({ brand: marker, badge: marker }), { instant })
    expect(result?.total).toBe(0)
    expect(tracked.statements.every((statement) => !statement.sql.includes(marker))).toBe(true)
    expect(tracked.statements.some((statement) => statement.parameters.includes(JSON.stringify([marker])))).toBe(true)
    expect(sqlite.prepare('SELECT count(*) AS n FROM products').get()).toMatchObject({ n: 20 })
  })

  it('serves fifty capacities over HTTP with the unchanged response and bounded production bindings', async () => {
    selectedProductFixture()
    const tracked = trackedDatabase()
    const parameters = new URLSearchParams({
      capacidad: fiftyValues('0.75-L', (index) => `${1000 + index}-Synthetic`),
      facets: '1',
      limit: '12'
    })
    const env = { DB: tracked.database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    const response = await worker.fetch(new Request(`https://neteco.invalid/api/products?${parameters}`), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 20,
          categoryId: expect.any(Number),
          minPrice: expect.any(Number),
          formats: expect.any(Number)
        })
      ]),
      total: expect.any(Number),
      page: 1,
      pages: expect.any(Number),
      facets: { capacidades: expect.arrayContaining([{ value: '0.75-L', units: 0.75, label: 'L', n: 1 }]) }
    })
    expect(
      tracked.statements.find((statement) => statement.sql.includes('SELECT count(*) AS total'))?.parameters
    ).toHaveLength(7)
    expect(tracked.statements.find((statement) => statement.sql.includes('LIMIT ? OFFSET ?'))?.parameters).toHaveLength(
      9
    )
    expect(Math.max(...tracked.statements.map((statement) => statement.parameters.length))).toBeLessThanOrEqual(100)
  })
})
