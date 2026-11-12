import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogTypedAttributeDefinition, CatalogTypedAttributeValue } from '../../shared/catalog-typed-attributes'
import { validateTypedAttributeValues } from '../../shared/catalog-typed-attributes'
import { listPublishedProducts, type ProductQuery } from '../../workers/catalog/products'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import {
  typedAttributeEntryValiditySql,
  typedAttributeNamespaceValiditySql
} from '../../workers/catalog/typed-attribute-sql'
import { CATEGORY_CLAIMS, ROOT_CATEGORY, categoryCommandFixture } from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  preparePublicTypedFacetsStatement,
  parsePublicTypedFacetsRows,
  type PublicTypedFacetRow
} from '../../workers/catalog/typed-attribute-facets'
import { testUuid } from '../support/deterministic'

const REASON = 'Definición sintética de facetas tipadas'
const TARGET = '90000000-0000-4000-8000-000000000058'
const query = (typed?: unknown, extra: Partial<ProductQuery> = {}): ProductQuery => ({
  page: 1,
  limit: 20,
  sort: 'name',
  facets: true,
  ...(typed === undefined ? {} : { typed: JSON.stringify(typed) }),
  ...extra
})

describe('Typed aggregate batch boundary', () => {
  it('prepares the aggregate without executing reads before the caller batch', () => {
    let prepared = 0,
      bound = 0,
      reads = 0
    const captured: unknown[] = []
    const statement = {
      bind(...parameters: unknown[]) {
        bound++
        captured.push(...parameters)
        return statement
      },
      all() {
        reads++
        throw new Error('The caller owns the final aggregate batch')
      }
    }
    const database = {
      prepare() {
        prepared++
        return statement
      }
    } as unknown as D1Database
    const result = preparePublicTypedFacetsStatement(database, {
      effectiveSummary: 'WITH variant_summary AS (SELECT 1 AS formats)',
      instantParameters: [],
      joins: 'FROM products p',
      filters: [{ key: 'active', clause: 'p.id = ?', parameters: ['synthetic-product'] }],
      typedFilters: [],
      instant: '2026-08-20T00:00:00Z'
    })
    expect(result).toBe(statement)
    expect({ prepared, bound, reads }).toEqual({ prepared: 1, bound: 1, reads: 0 })
    expect(captured.at(-1)).toBe('synthetic-product')
  })

  it('decodes only aggregate option rows without losing false, zero or unit identity', () => {
    const row = {
      definition_id: '90000000-0000-4000-8000-000000000061',
      category_legacy_id: 1,
      code: 'boolean-facet',
      kind: 'boolean',
      label: 'Booleano',
      current_revision: 1,
      value_json: 'false',
      option_label: null,
      reference_name: null,
      reference_id: null,
      n: 1001
    } satisfies PublicTypedFacetRow
    expect(
      parsePublicTypedFacetsRows([
        row,
        { ...row, definition_id: '90000000-0000-4000-8000-000000000062', kind: 'number', value_json: '0' },
        {
          ...row,
          definition_id: '90000000-0000-4000-8000-000000000063',
          kind: 'unit',
          value_json: '{"quantity":0,"unit":"kg"}'
        }
      ]).facets.map((facet) => facet.values)
    ).toEqual([
      [{ value: false, label: 'No', n: 1001 }],
      [{ value: 0, label: '0', n: 1001 }],
      [{ value: { quantity: 0, unit: 'kg' }, label: '0 Kilogramos', n: 1001 }]
    ])
  })
})

describe('D1 typed attribute filters and self-excluding facets', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_typed_attribute_definitions'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES (?,99,'c1','b1','Destino público','destino-publico','published')"
      )
      .run(TARGET)
    sqlite
      .prepare(
        "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES ('typed-target-variant',991,?,'t21','sp1','TYPED-TARGET','Botella','published',500)"
      )
      .run(TARGET)
    await provisionPublicationValidityFixture(database, {
      productIds: [...Array.from({ length: 6 }, (_, i) => `p-${i + 1}`), TARGET]
    })
    sqlite.limits.compoundSelect = 5
  })
  afterEach(() => sqlite.close())
  async function definition(kind: CatalogTypedAttributeDefinition['kind'], config: unknown, code = kind) {
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CATEGORY_CLAIMS,
        'create',
        {},
        {
          categoryId: 7,
          code,
          kind,
          label: `Atributo ${code}`,
          config,
          expectedVersion: 0,
          reason: REASON
        },
        { idempotencyKey: testUuid() }
      )
    ).definition
  }
  function set(product: string, values: Array<[CatalogTypedAttributeDefinition, CatalogTypedAttributeValue]>) {
    sqlite.prepare("UPDATE products SET attributes=json_set(attributes,'$.typed',json(?)) WHERE id=?").run(
      JSON.stringify({
        version: 1,
        values: values.map(([def, value]) => ({ definitionId: def.id, revision: def.revision, value }))
      }),
      product
    )
  }
  function aroundSnapshot(callback: () => void | Promise<void>, phase: 'before' | 'after') {
    let changed = false
    const statements: string[] = []
    const guarded = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'batch')
          return async <T>(batch: D1PreparedStatement[]) => {
            if (changed) return target.batch<T>(batch)
            changed = true
            if (phase === 'before') await callback()
            const result = await target.batch<T>(batch)
            if (phase === 'after') await callback()
            return result
          }
        if (property === 'prepare')
          return (sql: string) => {
            statements.push(sql)
            return target.prepare(sql)
          }
        const value: unknown = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return { guarded, statements, changed: () => changed }
  }

  it('does not collect more than 1000 self-excluded typed contributors into the bounded authority guard', async () => {
    const flag = await definition('boolean', {})
    set('p-1', [[flag, false]])
    set('p-2', [[flag, true]])
    const product = sqlite.prepare(
      "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes,regulatory) SELECT ?,?,category_id,brand_id,name,?,'published',attributes,regulatory FROM products WHERE id='p-2'"
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
    for (let index = 0; index < 1000; index++) {
      const id = `typed-contributor-${index}`
      product.run(id, 10_000 + index, id)
      variant.run(`${id}-variant`, 20_000 + index, id, id)
      policy.run(testUuid(), id)
      media.run(testUuid(), id, testUuid())
    }
    const result = await listPublishedProducts(database, query([{ definitionId: flag.id, values: [false] }]))
    expect(result?.total).toBe(1)
    expect(result?.facets?.typed?.find((f) => f.definitionId === flag.id)?.values).toEqual([
      { value: false, label: 'No', n: 1 },
      { value: true, label: 'Sí', n: 1001 }
    ])
  })

  it.each(
    (['before', 'after'] as const).flatMap((phase) =>
      (['contributor', 'reference', 'definition revision', 'definition retirement'] as const).map((condition) => ({
        phase,
        condition
      }))
    )
  )('keeps typed facets coherent when $condition changes $phase the atomic snapshot', async ({ condition, phase }) => {
    const flag = await definition('boolean', {}),
      ref = await definition('reference', {})
    set('p-1', [
      [flag, false],
      [ref, TARGET]
    ])
    set('p-2', [
      [flag, true],
      [ref, TARGET]
    ])
    const mutation = aroundSnapshot(async () => {
      if (condition === 'contributor') sqlite.prepare("UPDATE products SET status='hidden' WHERE id='p-2'").run()
      else if (condition === 'reference') sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(TARGET)
      else
        await executeD1CatalogTypedAttributeDefinitionCommand(
          database,
          CATEGORY_CLAIMS,
          condition === 'definition revision' ? 'update' : 'retire',
          { definitionId: ref.id },
          condition === 'definition revision'
            ? { label: 'Etiqueta final', config: {}, expectedVersion: 1, reason: REASON }
            : { expectedVersion: 1, reason: REASON },
          { idempotencyKey: testUuid() }
        )
    }, phase)
    const result = await listPublishedProducts(mutation.guarded, query([{ definitionId: flag.id, values: [false] }]))
    expect(mutation.changed()).toBe(true)
    const facet = result?.facets?.typed?.find((f) => f.definitionId === flag.id)
    expect(facet?.values).toEqual(
      phase === 'before' && condition === 'contributor'
        ? [{ value: false, label: 'No', n: 1 }]
        : [
            { value: false, label: 'No', n: 1 },
            { value: true, label: 'Sí', n: 1 }
          ]
    )
    const refFacet = result?.facets?.typed?.find((f) => f.definitionId === ref.id)
    if (phase === 'before' && (condition === 'reference' || condition === 'definition retirement'))
      expect(refFacet).toBeUndefined()
    else
      expect(refFacet).toMatchObject({
        label: phase === 'before' && condition === 'definition revision' ? 'Etiqueta final' : ref.label,
        values: [{ value: TARGET, label: 'Destino público', n: 1 }]
      })
    expect(result?.total).toBe(1)
    expect(result?.items.map((item) => item.uuid)).toEqual(['p-1'])
    expect(result?.items[0]?.image).toMatch(/^\/media\//)
    expect(result?.facets?.brands).toEqual([{ value: 'NETECO', n: 1 }])
    expect(mutation.statements.at(-1)).toContain('typed_requested AS MATERIALIZED')
    expect(mutation.statements.some((sql) => /json_group_array\(DISTINCT p\.id\)/.test(sql))).toBe(false)
  })

  it.each(['update', 'retire'] as const)(
    'fails closed if requested definition %s drifts between semantic preflight and batch admission',
    async (action) => {
      const flag = await definition('boolean', {})
      set('p-1', [[flag, false]])
      const mutation = aroundSnapshot(async () => {
        await executeD1CatalogTypedAttributeDefinitionCommand(
          database,
          CATEGORY_CLAIMS,
          action,
          { definitionId: flag.id },
          action === 'update'
            ? { label: 'Nueva revisión', config: {}, expectedVersion: 1, reason: REASON }
            : { expectedVersion: 1, reason: REASON },
          { idempotencyKey: testUuid() }
        )
      }, 'before')
      await expect(
        listPublishedProducts(mutation.guarded, query([{ definitionId: flag.id, values: [false] }]))
      ).rejects.toThrow('typed_attributes_changed')
      expect(mutation.changed()).toBe(true)
      expect(mutation.statements.some((sql) => sql.includes('count(*) AS admitted'))).toBe(true)
    }
  )

  it('combines OR selections within an attribute and AND attributes while preserving false and zero', async () => {
    const flag = await definition('boolean', {}),
      number = await definition('number', { precision: 2 }),
      list = await definition('list', {
        options: ['red', 'blue', 'green'].map((code) => ({ code, label: code.toUpperCase(), status: 'active' }))
      })
    set('p-1', [
      [flag, false],
      [number, 0],
      [list, ['red', 'blue']]
    ])
    set('p-2', [
      [flag, true],
      [number, 10],
      [list, ['red']]
    ])
    set('p-3', [
      [flag, true],
      [number, 0],
      [list, ['green']]
    ])
    const result = await listPublishedProducts(
      database,
      query([
        { definitionId: flag.id, values: [false, true] },
        { definitionId: list.id, values: ['red'] }
      ])
    )
    expect(result?.items.map((p) => p.uuid)).toEqual(['p-1', 'p-2'])
    expect(result?.total).toBe(2)
    const zero = await listPublishedProducts(database, query([{ definitionId: number.id, values: [0] }]))
    expect(zero?.items.map((p) => p.uuid)).toEqual(['p-1', 'p-3'])
    expect(zero?.facets?.typed?.find((f) => f.definitionId === number.id)?.values).toEqual([
      { value: 0, label: '0', n: 2 },
      { value: 10, label: '10', n: 1 }
    ])
  })

  it('self-excludes only its own typed axis, counts each product once and keeps fixed facets', async () => {
    const flag = await definition('boolean', {}),
      list = await definition('list', {
        options: ['red', 'blue'].map((code) => ({ code, label: code.toUpperCase(), status: 'active' }))
      })
    set('p-1', [
      [flag, false],
      [list, ['red', 'blue']]
    ])
    set('p-2', [
      [flag, true],
      [list, ['red']]
    ])
    const result = await listPublishedProducts(
      database,
      query([
        { definitionId: flag.id, values: [false] },
        { definitionId: list.id, values: ['red'] }
      ])
    )
    expect(result?.total).toBe(1)
    expect(result?.facets?.typed?.find((f) => f.definitionId === flag.id)?.values).toEqual([
      { value: false, label: 'No', n: 1 },
      { value: true, label: 'Sí', n: 1 }
    ])
    expect(result?.facets?.typed?.find((f) => f.definitionId === list.id)?.values).toEqual([
      { value: 'blue', label: 'BLUE', n: 1 },
      { value: 'red', label: 'RED', n: 1 }
    ])
    expect(result?.facets?.brands).toEqual([{ value: 'NETECO', n: 1 }])
    expect((await listPublishedProducts(database, query(undefined, { brand: 'Missing' })))?.facets?.typed).toEqual([])
  })

  it('matches quantity and unit together without cross-pair matches or implicit conversion', async () => {
    const unit = await definition('unit', { precision: 2, units: ['l', 'kg'] })
    set('p-1', [[unit, { quantity: 1, unit: 'l' }]])
    set('p-2', [[unit, { quantity: 2, unit: 'kg' }]])
    expect(
      (await listPublishedProducts(database, query([{ definitionId: unit.id, values: [{ quantity: 1, unit: 'kg' }] }])))
        ?.total
    ).toBe(0)
    expect(
      (
        await listPublishedProducts(
          database,
          query([
            {
              definitionId: unit.id,
              values: [
                { quantity: 1, unit: 'l' },
                { quantity: 2, unit: 'kg' }
              ]
            }
          ])
        )
      )?.total
    ).toBe(2)
  })

  it('uses immutable historical values but current definition/option labels, and hides withdrawn definitions', async () => {
    const list = await definition('list', {
      options: [{ code: 'stable', label: 'Etiqueta antigua', status: 'active' }]
    })
    set('p-1', [[list, ['stable']]])
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'update',
      { definitionId: list.id },
      {
        label: 'Etiqueta actual',
        config: { options: [{ code: 'stable', label: 'Opción actual', status: 'retired' }] },
        expectedVersion: 1,
        reason: REASON
      },
      { idempotencyKey: testUuid() }
    )
    const result = await listPublishedProducts(database, query([{ definitionId: list.id, values: ['stable'] }]))
    expect(result?.total).toBe(1)
    expect(result?.facets?.typed).toMatchObject([
      { definitionId: list.id, label: 'Etiqueta actual', values: [{ value: 'stable', label: 'Opción actual', n: 1 }] }
    ])
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: list.id },
      { expectedVersion: 2, reason: REASON },
      { idempotencyKey: testUuid() }
    )
    expect((await listPublishedProducts(database, query()))?.facets?.typed).toEqual([])
    await expect(
      listPublishedProducts(database, query([{ definitionId: list.id, values: ['stable'] }]))
    ).rejects.toMatchObject({ message: 'invalid_typed_filters' })
  })

  it('excludes private or publication-invalid reference destinations without leaking UUIDs or names', async () => {
    const ref = await definition('reference', {})
    set('p-1', [[ref, TARGET]])
    expect((await listPublishedProducts(database, query()))?.facets?.typed).toMatchObject([
      { kind: 'reference', values: [{ value: TARGET, label: 'Destino público', n: 1 }] }
    ])
    sqlite.prepare('UPDATE products SET status=? WHERE id=?').run('draft', TARGET)
    const result = await listPublishedProducts(database, query())
    expect(result?.facets?.typed).toEqual([])
    expect(JSON.stringify(result?.facets)).not.toContain(TARGET)
    sqlite.prepare('UPDATE products SET status=? WHERE id=?').run('published', TARGET)
    sqlite
      .prepare("UPDATE products SET regulatory=json_set(regulatory,'$.requiresSds',json('true')) WHERE id=?")
      .run(TARGET)
    expect((await listPublishedProducts(database, query()))?.facets?.typed).toEqual([])
  })

  it('hides an invalid envelope or duplicate IDs, but hides only a malformed individual entry', async () => {
    const flag = await definition('boolean', {}),
      number = await definition('number', { precision: 1 })
    set('p-1', [
      [flag, false],
      [number, 0]
    ])
    sqlite
      .prepare(
        "UPDATE products SET attributes=json_set(attributes,'$.typed.values[1].value','not-a-number') WHERE id='p-1'"
      )
      .run()
    expect((await listPublishedProducts(database, query()))?.facets?.typed?.map((f) => f.definitionId)).toEqual([
      flag.id
    ])
    sqlite
      .prepare("UPDATE products SET attributes=json_set(attributes,'$.typed.values[1].definitionId',?) WHERE id='p-1'")
      .run(flag.id)
    expect((await listPublishedProducts(database, query()))?.facets?.typed).toEqual([])
    set('p-1', [[flag, false]])
    sqlite.prepare("UPDATE products SET attributes=json_set(attributes,'$.typed.version',2) WHERE id='p-1'").run()
    expect((await listPublishedProducts(database, query()))?.facets?.typed).toEqual([])
  })

  it('uniformly rejects unknown, private and free-text filter definitions and malformed selection input', async () => {
    const text = await definition('text', { maxLength: 100 }),
      flag = await definition('boolean', {})
    const privateDef = (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CATEGORY_CLAIMS,
        'create',
        {},
        {
          categoryId: 12,
          code: 'private_flag',
          kind: 'boolean',
          label: 'Private label',
          config: {},
          expectedVersion: 0,
          reason: REASON
        },
        { idempotencyKey: testUuid() }
      )
    ).definition
    for (const filters of [
      [{ definitionId: testUuid(), values: [true] }],
      [{ definitionId: text.id, values: ['free'] }],
      [{ definitionId: privateDef.id, values: [true] }],
      [{ definitionId: flag.id, values: ['false'] }],
      [{ definitionId: flag.id, values: [false, false] }],
      [
        { definitionId: flag.id, values: [false] },
        { definitionId: flag.id, values: [true] }
      ]
    ])
      await expect(listPublishedProducts(database, query(filters))).rejects.toMatchObject({
        message: 'invalid_typed_filters'
      })
  })

  it.each(['hidden ancestor', 'cyclic ancestry', 'unmapped ancestor'] as const)(
    'uniformly rejects a typed filter whose category has %s',
    async (condition) => {
      const flag = await definition('boolean', {})
      set('p-1', [[flag, false]])
      sqlite.prepare("UPDATE categories SET parent_id=? WHERE id='c1'").run(ROOT_CATEGORY)
      const filtered = query([{ definitionId: flag.id, values: [false] }], { facets: false })
      expect((await listPublishedProducts(database, filtered))?.total).toBe(1)

      if (condition === 'hidden ancestor')
        sqlite.prepare("UPDATE categories SET status='hidden' WHERE id=?").run(ROOT_CATEGORY)
      else if (condition === 'cyclic ancestry')
        sqlite.prepare("UPDATE categories SET parent_id='c1' WHERE id=?").run(ROOT_CATEGORY)
      else sqlite.prepare('UPDATE categories SET legacy_id=NULL WHERE id=?').run(ROOT_CATEGORY)

      await expect(listPublishedProducts(database, filtered)).rejects.toMatchObject({
        code: 'invalid_typed_filters',
        message: 'invalid_typed_filters'
      })
    }
  )

  it('uses indexed definition/revision lookups and bounded batches/bindings, not queries per product', async () => {
    const number = await definition('number', { precision: 2 })
    for (let i = 1; i <= 6; i++) set(`p-${i}`, [[number, i % 2]])
    const captured: Array<{ sql: string; binds: unknown[] }> = []
    const tracked = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql),
              originalBind = statement.bind.bind(statement)
            statement.bind = (...binds: unknown[]) => {
              captured.push({ sql, binds })
              return originalBind(...binds)
            }
            return statement
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const result = await listPublishedProducts(tracked, query([{ definitionId: number.id, values: [0, 1] }]))
    expect(result?.total).toBe(6)
    expect(Math.max(...captured.map((c) => c.binds.length))).toBeLessThan(100)
    expect(captured.length).toBeLessThan(30)
    const actual = captured.find(
      (c) => c.sql.includes('catalog_typed_attribute_revisions') && c.sql.includes('count(*) AS total')
    )
    expect(actual).toBeDefined()
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${actual!.sql}`)
      .all(
        ...actual!.binds.map((v) =>
          typeof v === 'string' || typeof v === 'number' || v === null ? v : JSON.stringify(v)
        )
      )
      .map((r) => String(r.detail))
    expect(plan.some((line) => /SEARCH .*\(definition_id=\? AND revision=\?\)/.test(line))).toBe(true)
    expect(plan.some((line) => /SEARCH .*\(id=\?\)/.test(line))).toBe(true)
  })

  it('keeps SQL entry validation aligned with shared historical/write validation for all six kinds', async () => {
    const sourceId = '80000000-0000-4000-8000-000000000058'
    const definitions = [
      await definition('text', { maxLength: 3 }),
      await definition('number', { precision: 1, min: -1, max: 1 }),
      await definition('unit', { precision: 2, units: ['l'] }),
      await definition('boolean', {}),
      await definition('list', {
        options: [
          { code: 'old', label: 'Retired', status: 'retired' },
          { code: 'active', label: 'Active', status: 'active' }
        ]
      }),
      await definition('reference', {})
    ]
    const samples: unknown[][] = [
      ['a', '😀a', '😀ab', '', 'a\u0000b'],
      [0, 0.1, 0.1 + 0.2, -1, 1.1, '0'],
      [
        { quantity: 0, unit: 'l' },
        { quantity: 0.001, unit: 'l' },
        { quantity: 1, unit: 'kg' },
        { quantity: 1, unit: 'l', extra: 1 }
      ],
      [false, true, 0, 'false'],
      [['old'], ['active'], ['active', 'active'], ['unknown'], []],
      [TARGET, 'not-uuid', 'p-1']
    ]
    const cases = definitions.flatMap((def, index) =>
      samples[index]!.flatMap((value) =>
        (['historical', 'write'] as const).map((mode) => ({
          def,
          value,
          mode,
          expected: validateTypedAttributeValues(
            { version: 1, values: [{ definitionId: def.id, revision: 1, value }] },
            [def],
            { categoryId: 7, mode, productId: sourceId }
          ).success
        }))
      )
    )
    expect(cases.filter((item) => item.expected).length).toBeGreaterThan(10)
    expect(cases.filter((item) => !item.expected).length).toBeGreaterThan(10)
    for (const { def, value, mode, expected } of cases) {
      const entry = { definitionId: def.id, revision: 1, value },
        namespace = { version: 1, values: [entry] }
      const predicate = typedAttributeEntryValiditySql({
        entrySql: '?1',
        definitionAlias: 'd',
        revisionAlias: 'r',
        categoryIdSql: '?2',
        productIdSql: '?3',
        mode
      })
      const actual = sqlite
        .prepare(
          `SELECT CASE WHEN ${typedAttributeNamespaceValiditySql('?4')} AND ${predicate} THEN 1 ELSE 0 END AS valid FROM catalog_typed_attribute_definitions d JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id AND r.revision=1 WHERE d.id=?5`
        )
        .get(JSON.stringify(entry), 'c1', sourceId, JSON.stringify(namespace), def.id)
      expect(actual?.valid, JSON.stringify({ kind: def.kind, value, mode })).toBe(Number(expected))
    }
    for (const scalar of ['not JSON', '"scalar"', 'null', '42', '[]']) {
      const predicate = typedAttributeEntryValiditySql({
        entrySql: '?1',
        definitionAlias: 'd',
        revisionAlias: 'r',
        categoryIdSql: '?2',
        mode: 'historical'
      })
      expect(
        sqlite
          .prepare(
            `SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS valid
        FROM catalog_typed_attribute_definitions d JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id AND r.revision=1
        WHERE d.id=?3`
          )
          .get(scalar, 'c1', definitions[0]!.id)?.valid
      ).toBe(0)
      expect(
        sqlite
          .prepare(`SELECT CASE WHEN ${typedAttributeNamespaceValiditySql('?1')} THEN 1 ELSE 0 END AS valid`)
          .get(scalar)?.valid
      ).toBe(0)
    }
  })
})
