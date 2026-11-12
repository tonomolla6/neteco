import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogTypedAttributeDefinition, CatalogTypedAttributeValue } from '../../shared/catalog-typed-attributes'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { publicationValidityExpression } from '../../workers/catalog/publication-validity'
import {
  catalogTypedAttributeIntegritySql,
  type CatalogTypedAttributeIntegritySqlOptions
} from '../../workers/catalog/typed-attribute-integrity'
import { CATEGORY_CLAIMS, categoryCommandFixture } from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const SOURCE = '80000000-0000-4000-8000-000000000058'
const TARGET = '90000000-0000-4000-8000-000000000058'
const NOW = '2026-10-08T00:00:00Z'
const EXPIRY = '2026-10-09T00:00:00Z'
const REASON = 'Definición sintética para integridad tipada'
const BASE: CatalogTypedAttributeIntegritySqlOptions = {
  sourceSql: 'SELECT id,category_id,attributes FROM products WHERE id=?2',
  mode: 'write',
  clockSql: "COALESCE(?1,'now')"
}

describe('D1 live typed attribute integrity guard', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_typed_attribute_definitions'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    seedInventoryFixture(sqlite)
    for (const [id, legacyId] of [
      [SOURCE, 98],
      [TARGET, 99]
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES (?,?,'c1','b1',?,?,'published')"
        )
        .run(id, legacyId, `Producto ${legacyId}`, `typed-integrity-${legacyId}`)
      sqlite
        .prepare(
          "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES (?,?,?,'t21','sp1',?,'Botella','published',500)"
        )
        .run(`integrity-${legacyId}`, 900 + legacyId, id, `INTEGRITY-${legacyId}`)
    }
    await provisionPublicationValidityFixture(database, { productIds: [TARGET], now: NOW, validUntil: EXPIRY })
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
        { idempotencyKey: testUuid() }
      )
    ).definition
  }
  function set(raw: unknown, id = SOURCE) {
    sqlite
      .prepare("UPDATE products SET attributes=json_set(attributes,'$.typed',json(?)) WHERE id=?")
      .run(JSON.stringify(raw), id)
  }
  function values(entries: Array<[CatalogTypedAttributeDefinition, CatalogTypedAttributeValue]>) {
    set({
      version: 1,
      values: entries.map(([definition, value]) => ({
        definitionId: definition.id,
        revision: definition.revision,
        value
      }))
    })
  }
  function valid(options: Partial<CatalogTypedAttributeIntegritySqlOptions> = {}, now = NOW) {
    return sqlite
      .prepare(`SELECT ${catalogTypedAttributeIntegritySql({ ...BASE, ...options })} AS valid`)
      .get(now, SOURCE)?.valid
  }

  it('allows absent typed data, an empty envelope and empty caller sources', () => {
    expect(valid()).toBe(1)
    set({ version: 1, values: [] })
    expect(valid()).toBe(1)
    expect(valid({ sourceSql: 'SELECT id,category_id,attributes FROM products WHERE id=?2 AND 0' })).toBe(1)
  })

  it('rejects malformed envelopes, duplicates and any malformed entry instead of hiding it', async () => {
    const flag = await definition('boolean', {})
    const entry = { definitionId: flag.id, revision: 1, value: false }
    for (const raw of [
      null,
      { version: 2, values: [] },
      { version: 1, values: [], extra: true },
      { version: 1, values: [entry, entry] },
      { version: 1, values: [entry, 'not-json'] }
    ]) {
      set(raw)
      expect(valid()).toBe(0)
    }
  })

  it('accepts all six kinds together preserving false, zero and paired units', async () => {
    const text = await definition('text', { maxLength: 10 }),
      number = await definition('number', { precision: 2 }),
      unit = await definition('unit', { precision: 2, units: ['l'] }),
      flag = await definition('boolean', {}),
      list = await definition('list', { options: [{ code: 'stable', label: 'Estable', status: 'active' }] }),
      ref = await definition('reference', {})
    values([
      [text, 'Texto'],
      [number, 0],
      [unit, { quantity: 0, unit: 'l' }],
      [flag, false],
      [list, ['stable']],
      [ref, TARGET]
    ])
    expect(valid()).toBe(1)
    expect(valid({ mode: 'historical', requirePublicReferences: true })).toBe(1)
  })

  it.each([
    ['text', { maxLength: 3 }, 'too long'],
    ['number', { precision: 1 }, 0.1 + 0.2],
    ['unit', { precision: 2, units: ['l'] }, { quantity: 0, unit: 'kg' }],
    ['boolean', {}, 0],
    ['list', { options: [{ code: 'stable', label: 'Estable', status: 'active' }] }, ['missing']],
    ['reference', {}, 'not-a-uuid']
  ] as const)('rejects invalid %s values using the shared SQL entry rules', async (kind, config, value) => {
    const def = await definition(kind, config)
    set({ version: 1, values: [{ definitionId: def.id, revision: 1, value }] })
    expect(valid()).toBe(0)
  })

  it.each(['unknown definition', 'missing revision', 'wrong category'] as const)(
    'rejects %s rather than dropping unmatched entries',
    async (condition) => {
      const def = await definition('boolean', {})
      values([[def, false]])
      if (condition === 'unknown definition')
        set({ version: 1, values: [{ definitionId: testUuid(), revision: 1, value: false }] })
      else if (condition === 'missing revision')
        set({ version: 1, values: [{ definitionId: def.id, revision: 999, value: false }] })
      else
        sqlite
          .prepare('UPDATE products SET category_id=(SELECT id FROM categories WHERE legacy_id=10) WHERE id=?')
          .run(SOURCE)
      expect(valid()).toBe(0)
      expect(valid({ mode: 'historical' })).toBe(0)
    }
  )

  it.each(['self', 'missing', 'draft'] as const)('rejects a %s reference in write mode', async (condition) => {
    const ref = await definition('reference', {})
    values([[ref, condition === 'self' ? SOURCE : condition === 'missing' ? testUuid() : TARGET]])
    if (condition === 'draft') sqlite.prepare("UPDATE products SET status='draft' WHERE id=?").run(TARGET)
    expect(valid()).toBe(0)
  })

  it('uses the supplied execution clock and rechecks live policy drift', async () => {
    const ref = await definition('reference', {})
    values([[ref, TARGET]])
    expect(valid()).toBe(1)
    expect(valid({}, '2026-10-07T23:59:59Z')).toBe(0)
    expect(valid({}, EXPIRY)).toBe(0)
    sqlite
      .prepare("UPDATE products SET regulatory=json_set(regulatory,'$.requiresSds',json('true')) WHERE id=?")
      .run(TARGET)
    expect(valid()).toBe(0)
    expect(valid({ mode: 'historical', requirePublicReferences: true })).toBe(0)
  })

  it('rejects a reference destination with only draft variants despite otherwise valid publication evidence', async () => {
    const ref = await definition('reference', {})
    values([[ref, TARGET]])
    expect(valid()).toBe(1)
    sqlite.prepare("UPDATE variants SET status='draft' WHERE product_id=?").run(TARGET)
    expect(valid()).toBe(0)
    expect(valid({ mode: 'historical', requirePublicReferences: true })).toBe(0)
    expect(valid({ mode: 'historical' })).toBe(1)
  })

  it('retains exact historical revisions and retired options without making them writable', async () => {
    const list = await definition('list', { options: [{ code: 'stable', label: 'Original', status: 'active' }] })
    values([[list, ['stable']]])
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'update',
      { definitionId: list.id },
      {
        label: 'Actual',
        config: { options: [{ code: 'stable', label: 'Retirada', status: 'retired' }] },
        expectedVersion: 1,
        reason: REASON
      },
      { idempotencyKey: testUuid() }
    )
    expect(valid()).toBe(0)
    expect(valid({ mode: 'historical' })).toBe(1)
    set({ version: 1, values: [{ definitionId: list.id, revision: 2, value: ['stable'] }] })
    expect(valid()).toBe(0)
    expect(valid({ mode: 'historical' })).toBe(1)
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: list.id },
      { expectedVersion: 2, reason: REASON },
      { idempotencyKey: testUuid() }
    )
    expect(valid()).toBe(0)
    expect(valid({ mode: 'historical' })).toBe(1)
    expect(valid({ mode: 'historical', requirePublicReferences: true })).toBe(1)
  })

  it('preserves historical references by default but public historical checks fail closed', async () => {
    const ref = await definition('reference', {})
    values([[ref, TARGET]])
    sqlite.prepare("UPDATE products SET status='draft' WHERE id=?").run(TARGET)
    expect(valid({ mode: 'historical' })).toBe(1)
    expect(valid({ mode: 'historical', requirePublicReferences: true })).toBe(0)
  })

  it('does not recursively follow typed attributes of an otherwise eligible reference destination', async () => {
    const ref = await definition('reference', {})
    values([[ref, TARGET]])
    set({ version: 999, values: ['not-json'] }, TARGET)
    expect(valid()).toBe(1)
  })

  it('checks every bounded source row inside a final status guard with indexed identities', async () => {
    const flag = await definition('boolean', {}),
      ref = await definition('reference', {})
    values([
      [flag, false],
      [ref, TARGET]
    ])
    await provisionPublicationValidityFixture(database, { productIds: [SOURCE], now: NOW, validUntil: EXPIRY })
    const expression = catalogTypedAttributeIntegritySql({
      ...BASE,
      prefix: 'final_typed',
      sourceSql: 'SELECT id,category_id,attributes FROM products WHERE id IN (?2,?3)'
    })
    const sql = `SELECT EXISTS(SELECT 1 FROM products live WHERE live.id=?2 AND live.status='published'
      AND ${publicationValidityExpression('live', BASE.clockSql)} AND ${expression}) AS valid`
    expect(sqlite.prepare(sql).get(NOW, SOURCE, 'p-1')?.valid).toBe(1)
    set({ version: 1, values: ['invalid entry'] }, 'p-1')
    expect(sqlite.prepare(sql).get(NOW, SOURCE, 'p-1')?.valid).toBe(0)
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(NOW, SOURCE, 'p-1')
      .map((row) => String(row.detail))
    expect(plan.some((line) => /SEARCH .*\(definition_id=\? AND revision=\?\)/.test(line))).toBe(true)
    expect(plan.some((line) => /SEARCH .*\(id=\?\)/.test(line))).toBe(true)
  })

  it('rejects unsafe prefixes instead of inserting caller text into SQL aliases', () => {
    expect(() => catalogTypedAttributeIntegritySql({ ...BASE, prefix: 'bad); SELECT 1' })).toThrow(
      'invalid_typed_attribute_integrity_sql'
    )
  })
})
