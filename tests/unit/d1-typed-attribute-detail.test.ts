import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogTypedAttributeDefinition, CatalogTypedAttributeValue } from '../../shared/catalog-typed-attributes'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { CATEGORY_CLAIMS, categoryCommandFixture } from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const TARGET = '90000000-0000-4000-8000-000000000058'
const REASON = 'Definición sintética de detalle tipado'
describe('D1 public detail with historically typed attributes', () => {
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
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', TARGET]
    })
    sqlite.limits.compoundSelect = 5
  })
  afterEach(() => sqlite.close())
  async function definition(kind: CatalogTypedAttributeDefinition['kind'], config: unknown) {
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CATEGORY_CLAIMS,
        'create',
        {},
        {
          categoryId: 7,
          code: kind,
          kind,
          label: `Atributo ${kind}`,
          config,
          expectedVersion: 0,
          reason: REASON
        },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).definition
  }
  function set(values: Array<[CatalogTypedAttributeDefinition, CatalogTypedAttributeValue]>) {
    sqlite
      .prepare(
        'UPDATE products SET attributes=json_set(attributes,\'$.typed\',json(?),\'$.attrs\',json(\'[{"k":"Legacy","v":"Preservado"}]\')) WHERE id=\'p-1\''
      )
      .run(
        JSON.stringify({
          version: 1,
          values: values.map(([def, value]) => ({ definitionId: def.id, revision: def.revision, value }))
        })
      )
  }

  it('adds six validated typed values without changing legacy attributes, prices or governed media', async () => {
    const before = await getPublishedProductDetail(database, 'producto-1')
    const text = await definition('text', { maxLength: 100 }),
      number = await definition('number', { precision: 2 }),
      unit = await definition('unit', { precision: 2, units: ['l'] }),
      flag = await definition('boolean', {}),
      list = await definition('list', { options: [{ code: 'red', label: 'Rojo', status: 'active' }] }),
      ref = await definition('reference', {})
    set([
      [text, '<texto seguro>'],
      [number, 0],
      [unit, { quantity: 0, unit: 'l' }],
      [flag, false],
      [list, ['red']],
      [ref, TARGET]
    ])
    const detail = await getPublishedProductDetail(database, 'producto-1')
    expect(detail?.attrs).toEqual([{ k: 'Legacy', v: 'Preservado' }])
    expect(detail?.variants).toEqual(before?.variants)
    expect(detail?.image).toBe(before?.image)
    expect(detail?.typedAttrs).toHaveLength(6)
    expect(detail?.typedAttrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ definitionId: text.id, value: '<texto seguro>', displayValue: '<texto seguro>' }),
        expect.objectContaining({ definitionId: number.id, value: 0, displayValue: '0' }),
        expect.objectContaining({ definitionId: flag.id, value: false, displayValue: 'No' }),
        expect.objectContaining({ definitionId: list.id, value: ['red'], displayValue: 'Rojo' }),
        expect.objectContaining({ definitionId: ref.id, value: TARGET, displayValue: 'Destino público' })
      ])
    )
  })

  it('uses exact immutable definition and list labels even after their current presentation changes', async () => {
    const list = await definition('list', { options: [{ code: 'red', label: 'Rojo original', status: 'active' }] })
    set([[list, ['red']]])
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'update',
      { definitionId: list.id },
      {
        label: 'Definición nueva',
        config: { options: [{ code: 'red', label: 'Rojo nuevo', status: 'retired' }] },
        expectedVersion: 1,
        reason: REASON
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs).toEqual([
      {
        definitionId: list.id,
        revision: 1,
        code: 'list',
        kind: 'list',
        label: 'Atributo list',
        value: ['red'],
        displayValue: 'Rojo original'
      }
    ])
  })

  it('omits only invalid historical entries and exact-category mismatches', async () => {
    const flag = await definition('boolean', {}),
      number = await definition('number', { precision: 1 })
    set([
      [flag, false],
      [number, 0.1 + 0.2]
    ])
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs?.map((a) => a.definitionId)).toEqual([
      flag.id
    ])
    sqlite
      .prepare("UPDATE products SET attributes=json_set(attributes,'$.typed.values[0].revision',999) WHERE id='p-1'")
      .run()
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs).toEqual([])
    set([[flag, false]])
    sqlite.prepare("UPDATE products SET category_id=? WHERE id='p-1'").run('30000000-0000-4000-8000-000000000040')
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs).toEqual([])
  })

  it.each(['draft', 'hidden', 'discontinued'])('never publishes a reference to a %s destination', async (status) => {
    const ref = await definition('reference', {}),
      flag = await definition('boolean', {})
    set([
      [ref, TARGET],
      [flag, false]
    ])
    sqlite.prepare('UPDATE products SET status=? WHERE id=?').run(status, TARGET)
    const detail = await getPublishedProductDetail(database, 'producto-1')
    expect(detail?.typedAttrs?.map((a) => a.definitionId)).toEqual([flag.id])
    expect(JSON.stringify(detail?.typedAttrs)).not.toContain(TARGET)
    expect(JSON.stringify(detail?.typedAttrs)).not.toContain('Destino público')
  })

  it('omits a published reference without real publication evidence and omits withdrawn definitions', async () => {
    const ref = await definition('reference', {}),
      flag = await definition('boolean', {})
    set([
      [ref, TARGET],
      [flag, false]
    ])
    sqlite
      .prepare("UPDATE products SET regulatory=json_set(regulatory,'$.requiresSds',json('true')) WHERE id=?")
      .run(TARGET)
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs?.map((a) => a.definitionId)).toEqual([
      flag.id
    ])
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: flag.id },
      { expectedVersion: 1, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs).toEqual([])
  })

  it('treats malformed namespaces, duplicate identities and JSON scalar entries defensively', async () => {
    const flag = await definition('boolean', {})
    for (const namespace of [
      null,
      [],
      'not-json-object',
      { version: 2, values: [] },
      {
        version: 1,
        values: [1, 'scalar', null]
      },
      {
        version: 1,
        values: [
          { definitionId: flag.id, revision: 1, value: false },
          { definitionId: flag.id, revision: 1, value: true }
        ]
      }
    ]) {
      sqlite
        .prepare("UPDATE products SET attributes=json_set(attributes,'$.typed',json(?)) WHERE id='p-1'")
        .run(JSON.stringify(namespace))
      expect((await getPublishedProductDetail(database, 'producto-1'))?.typedAttrs).toEqual([])
    }
  })
})
