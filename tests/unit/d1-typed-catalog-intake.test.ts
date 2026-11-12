import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS as claims,
  CATEGORY_SESSION
} from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { previewNativeCatalogImport, executeNativeCatalogImportCommand } from '../../workers/catalog/native-import'
import {
  createCatalogImportJob,
  uploadCatalogImportJobPage,
  sealCatalogImportJob
} from '../../workers/catalog/import-job'
import { executeCatalogImportJobCommand } from '../../workers/catalog/import-job-commands'
import type {
  CatalogTypedAttributeDefinition,
  CatalogTypedAttributeValues
} from '../../shared/catalog-typed-attributes'
import type { CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import { testUuid, testNow } from '../support/deterministic'

const REFERENCE = '60000000-0000-4000-8000-000000000061'
const CONSUMER = '60000000-0000-4000-8000-000000000062'
const WAREHOUSE = '60000000-0000-4000-8000-000000000063'
const reason = 'Synthetic typed intake review, not production authority'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
type Kind = 'native' | 'job'
interface Ready {
  kind: Kind
  id: string
  hash: string
}

describe('typed attributes throughout native and whole-job catalog intake', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    seedInventoryFixture(sqlite)
    sqlite.prepare("UPDATE inventory_locations SET active=0 WHERE kind='warehouse'").run()
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES(?,'TYPED-WH','Synthetic warehouse','warehouse',1,?)"
      )
      .run(WAREHOUSE, utc(-86400_000))
    sqlite.limits.compoundSelect = 5
    sqlite.limits.likePatternLength = 50
    sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(72 * 3600_000), CATEGORY_SESSION)
    sqlite.exec(
      "INSERT OR IGNORE INTO permissions VALUES('inventory.write','inventory','write','Synthetic intake fixture'); INSERT INTO role_permissions VALUES('category_admin','inventory.write')"
    )
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES(?,'TYPED-INTAKE','Synthetic source','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES(?,60,'Intake family','typed-intake','published')"
      )
      .run(ids.category)
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES(?,'Intake brand','typed-intake-brand','published')")
      .run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES(?,'INTAKE-TAX','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES(?,'INTAKE-SHIP','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES(?,61,?,'Synthetic reference','intake-reference','published')"
      )
      .run(REFERENCE, ids.category)
    sqlite
      .prepare(
        "INSERT INTO variants(id,product_id,legacy_id,sku,format,status,tax_class_id,shipping_profile_id,price_gross_cents) VALUES('intake-reference-variant',?,610,'INTAKE-REFERENCE','Unit','published','t21','sp1',100)"
      )
      .run(REFERENCE)
    await provisionPublicationValidityFixture(database, { productIds: [REFERENCE] })
  })
  afterEach(() => sqlite?.close())
  const values = (definition: CatalogTypedAttributeDefinition, value: unknown): CatalogTypedAttributeValues =>
    ({
      version: 1,
      values: [{ definitionId: definition.id, revision: definition.revision, value }]
    }) as CatalogTypedAttributeValues
  async function definition(kind = 'text', config: unknown = { maxLength: 500 }, categoryId = 60) {
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        claims,
        'create',
        {},
        {
          categoryId,
          code: `intake_${testUuid().replaceAll('-', '')}`,
          kind,
          config,
          label: 'Synthetic attribute',
          expectedVersion: 0,
          reason
        },
        { idempotencyKey: testUuid() }
      )
    ).definition
  }
  const retire = (d: CatalogTypedAttributeDefinition) =>
    executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      claims,
      'retire',
      { definitionId: d.id },
      { expectedVersion: d.revision, reason },
      { idempotencyKey: testUuid() }
    )
  function record(typed?: CatalogTypedAttributeValues, index = 1): CatalogTabularRecord {
    const product = index === 1 ? ids.product : '60000000-0000-4000-8000-000000000002'
    const variant = index === 1 ? ids.variant : '60000000-0000-4000-8000-000000000003'
    const asset = index === 1 ? ids.image : '60000000-0000-4000-8000-000000000004'
    const original = catalogRecord()
    return {
      ...original,
      product_id: product,
      variant_id: variant,
      asset_id: asset,
      product_legacy_id: String(900000 + index),
      variant_legacy_id: String(910000 + index),
      product_slug: `typed-intake-${index}`,
      sku: `TYPED-INTAKE-${index}`,
      ean: '',
      gtin: '',
      mpn: `TYPED-INTAKE-MPN-${index}`,
      identifier_exception_reason: 'Synthetic supplier MPN, drafts only',
      asset_storage_key: `clean/${asset}.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: index.toString(16).padStart(64, '0'),
      inventory_json: JSON.stringify([{ locationId: WAREHOUSE, physicalQuantity: 40, blockedQuantity: 2, version: 1 }]),
      product_attributes_json: JSON.stringify({
        ...JSON.parse(original.product_attributes_json),
        image: `/media/${asset}`,
        attrs: [{ k: 'Legacy', v: 'Preserved' }],
        unknown: { nested: [false, 0, null, 'Unicode 😀'] },
        ...(typed ? { typed } : {})
      })
    }
  }
  async function stage(records: CatalogTabularRecord[], db = database) {
    const job = await createCatalogImportJob(db, claims, { totalPages: 1, recordCount: records.length })
    expect(await uploadCatalogImportJobPage(db, claims, job.id, { index: 0, records })).toMatchObject({
      outcome: 'job',
      receivedPages: 1
    })
    return job
  }
  async function preview(kind: Kind, records: CatalogTabularRecord[], db = database) {
    if (kind === 'native') return previewNativeCatalogImport(db, claims, { records })
    const job = await stage(records)
    return sealCatalogImportJob(db, claims, job.id, { reason })
  }
  async function ready(kind: Kind, records: CatalogTabularRecord[]): Promise<Ready> {
    const result = await preview(kind, records)
    if (result.outcome === 'invalid') throw new Error(`synthetic_fixture_not_ready:${JSON.stringify(result.issues)}`)
    return { kind, id: result.id, hash: result.hash! }
  }
  const command = (
    ready: Ready,
    action: 'apply' | 'revert' = 'apply',
    key = testUuid(),
    db = database,
    now?: string
  ) =>
    ready.kind === 'native'
      ? executeNativeCatalogImportCommand(
          db,
          claims,
          ready.id,
          action,
          { previewHash: ready.hash, reason },
          key,
          now ? { now } : {}
        )
      : executeCatalogImportJobCommand(
          db,
          claims,
          ready.id,
          action,
          { previewHash: ready.hash, reason },
          key,
          now ? { now } : {}
        )
  function beforeBatch(before: () => void | Promise<void>): D1Database {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await before()
            return database.batch(statements)
          }
        return Reflect.get(target, key, receiver)
      }
    })
  }
  function state() {
    return Object.fromEntries(
      [
        'products',
        'variants',
        'media_assets',
        'product_media',
        'variant_price_versions',
        'inventory_balances',
        'inventory_movements',
        'catalog_native_previews',
        'catalog_native_commands',
        'catalog_native_audit',
        'catalog_native_guards',
        'catalog_import_jobs',
        'catalog_import_job_pages',
        'catalog_import_job_seals',
        'catalog_import_job_commands',
        'catalog_import_job_command_audit',
        'catalog_import_job_guards',
        'catalog_draft_legacy_counters',
        'media_uploads',
        'media_scan_receipts',
        'media_rights_decisions',
        'product_media_publications',
        'role_permissions',
        'identity_roles'
      ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
    )
  }
  async function invalid(kind: Kind, records: CatalogTabularRecord[]) {
    const before = sqlite.prepare('SELECT id FROM products ORDER BY id').all()
    expect(await preview(kind, records)).toMatchObject({
      outcome: 'invalid',
      issues: [{ code: 'invalid_typed_values' }]
    })
    expect(sqlite.prepare('SELECT id FROM products ORDER BY id').all()).toEqual(before)
  }
  describe.each<Kind>(['native', 'job'])('%s pipeline', (kind) => {
    it('accepts all six types, preserves source/legacy JSON, replays after TTL and compensates despite retirement', async () => {
      const specs: Array<[string, unknown, unknown]> = [
        ['text', { maxLength: 500 }, '  Unicode 😀  '],
        ['number', { precision: 2 }, 0],
        ['unit', { precision: 2, units: ['l'] }, { quantity: 0.25, unit: 'l' }],
        ['boolean', {}, false],
        ['list', { options: [{ code: 'blue', label: 'Azul', status: 'active' }] }, ['blue']],
        ['reference', {}, REFERENCE]
      ]
      const definitions: CatalogTypedAttributeDefinition[] = [],
        namespace: CatalogTypedAttributeValues = { version: 1, values: [] }
      for (const [type, config, value] of specs) {
        const d = await definition(type, config)
        definitions.push(d)
        namespace.values.push(...values(d, value).values)
      }
      const records = [record(namespace)],
        source = JSON.stringify(records),
        prepared = await ready(kind, records),
        key = testUuid()
      const statements: string[] = [],
        plans: string[] = []
      const traced = new Proxy(database, {
        get(target, key, receiver) {
          if (key === 'prepare')
            return (sql: string) => {
              statements.push(sql)
              const statement = database.prepare(sql)
              return new Proxy(statement, {
                get(target, key, receiver) {
                  if (key === 'bind')
                    return (...bindings: Array<string | number | null>) => {
                      if (sql.includes('typed_check AS MATERIALIZED')) {
                        plans.push(
                          ...sqlite
                            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                            .all(...bindings)
                            .map((row) => String(row.detail))
                        )
                      }
                      return statement.bind(...bindings)
                    }
                  return Reflect.get(target, key, receiver)
                }
              })
            }
          return Reflect.get(target, key, receiver)
        }
      })
      const applied = await command(prepared, 'apply', key, traced)
      expect(
        JSON.parse(String(sqlite.prepare('SELECT attributes FROM products WHERE id=?').get(ids.product)!.attributes))
      ).toEqual(JSON.parse(records[0]!.product_attributes_json))
      await retire(definitions[0]!)
      expect(await command(prepared, 'apply', key, database, utc(2 * 3600_000))).toEqual(applied)
      const revertKey = testUuid(),
        reverted = await command(prepared, 'revert', revertKey, traced)
      expect(await command(prepared, 'revert', revertKey, database, utc(2 * 3600_000))).toEqual(reverted)
      expect(sqlite.prepare('SELECT status FROM products WHERE id=?').get(ids.product)).toEqual({
        status: 'discontinued'
      })
      expect(JSON.stringify(records)).toBe(source)
      expect(Math.max(...statements.map((sql) => new TextEncoder().encode(sql).byteLength))).toBeLessThanOrEqual(
        100_000
      )
      expect(plans.some((line) => /SEARCH public_reference .*INDEX/.test(line))).toBe(true)
      expect(plans.some((line) => /SCAN public_reference\b/.test(line))).toBe(false)
      if (kind === 'job') {
        expect(plans.some((line) => /SEARCH target .*\(job_id=\? AND kind=\? AND item_id=\?\)/.test(line))).toBe(true)
        expect(plans.some((line) => /SCAN target\b/.test(line))).toBe(false)
      }
    })
    it('rejects unknown definitions, wrong category/revision, precision violations and retired definitions', async () => {
      const d = await definition('number', { precision: 1 }),
        other = await definition('text', { maxLength: 500 }, 12)
      await invalid(kind, [record(values(d, 0.30000000000000004))])
      await invalid(kind, [record(values({ ...d, id: testUuid() }, 1))])
      await invalid(kind, [record(values({ ...d, revision: 2 }, 1))])
      await invalid(kind, [record(values(other, 'Wrong category'))])
      await retire(d)
      await invalid(kind, [record(values(d, 1))])
    })
    it('rejects missing/hidden references and references to new drafts in the same batch', async () => {
      const d = await definition('reference', {})
      await invalid(kind, [record(values(d, testUuid()))])
      sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(REFERENCE)
      await invalid(kind, [record(values(d, REFERENCE))])
      const next = record(undefined, 2)
      await invalid(kind, [record(values(d, next.product_id)), next])
    })
    it('rejects definition revision drift after review without effects', async () => {
      const d = await definition(),
        prepared = await ready(kind, [record(values(d, 'Before revision'))])
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        claims,
        'update',
        { definitionId: d.id },
        { label: 'Revised', config: { maxLength: 500 }, expectedVersion: 1, reason },
        { idempotencyKey: testUuid() }
      )
      const before = state()
      await expect(command(prepared)).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
    })
    it('rejects definition retirement between preflight and atomic apply', async () => {
      const d = await definition(),
        prepared = await ready(kind, [record(values(d, 'Before retirement'))]),
        before = state()
      await expect(
        command(
          prepared,
          'apply',
          testUuid(),
          beforeBatch(async () => {
            await retire(d)
          })
        )
      ).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
    })
    it('rolls back reference withdrawal during the apply transaction, including the withdrawal itself', async () => {
      const d = await definition('reference', {}),
        prepared = await ready(kind, [record(values(d, REFERENCE))]),
        before = state()
      sqlite.exec(
        `CREATE TRIGGER intake_reference_drift AFTER INSERT ON products WHEN NEW.id='${ids.product}' BEGIN UPDATE products SET status='hidden' WHERE id='${REFERENCE}'; END`
      )
      await expect(command(prepared)).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
    })
    it('rolls back reference withdrawal within the preview/seal transaction', async () => {
      const d = await definition('reference', {}),
        records = [record(values(d, REFERENCE))]
      const job = kind === 'job' ? await stage(records) : null,
        before = state()
      sqlite.exec(
        `CREATE TRIGGER intake_preview_drift AFTER INSERT ON ${kind === 'native' ? 'catalog_native_previews' : 'catalog_import_job_seals'} BEGIN UPDATE products SET status='hidden' WHERE id='${REFERENCE}'; END`
      )
      const result =
        kind === 'native'
          ? await previewNativeCatalogImport(database, claims, { records })
          : await sealCatalogImportJob(database, claims, job!.id, { reason })
      expect(result.outcome).toBe('invalid')
      expect(state()).toEqual(before)
    })
    it('blocks exact compensation for valid external historical typed references, not malformed opaque JSON', async () => {
      const d = await definition('reference', {}),
        prepared = await ready(kind, [record()])
      await command(prepared)
      sqlite
        .prepare(
          "INSERT INTO products(id,legacy_id,category_id,name,slug,status,attributes) VALUES(?,62,?,'Synthetic consumer','intake-consumer','draft',?)"
        )
        .run(CONSUMER, ids.category, JSON.stringify({ typed: values(d, ids.product) }))
      await retire(d)
      const before = state()
      await expect(command(prepared, 'revert')).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
      sqlite
        .prepare('UPDATE products SET attributes=? WHERE id=?')
        .run(JSON.stringify({ typed: { ...values(d, ids.product), version: 2 } }), CONSUMER)
      const opaqueBefore = state()
      sqlite.exec(`CREATE TRIGGER intake_late_usage AFTER UPDATE ON products WHEN NEW.id='${ids.product}' AND NEW.status='discontinued'
        BEGIN UPDATE products SET attributes='${JSON.stringify({ typed: values(d, ids.product) })}' WHERE id='${CONSUMER}'; END`)
      await expect(command(prepared, 'revert')).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(opaqueBefore)
      sqlite.exec('DROP TRIGGER intake_late_usage')
      expect(await command(prepared, 'revert')).toMatchObject({ action: 'revert', updated: true })
    })
  })
})
