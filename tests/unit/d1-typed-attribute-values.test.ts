import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readD1CatalogTypedAttributeProduct,
  updateD1CatalogTypedAttributeValues
} from '../../workers/catalog/typed-attribute-values'
import { updateD1DraftProductMetadata } from '../../workers/catalog/admin-catalog-mutations'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import {
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema
} from '../../shared/catalog-typed-attribute-views'
import type {
  CatalogTypedAttributeDefinition,
  CatalogTypedAttributeValues
} from '../../shared/catalog-typed-attributes'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_SESSION,
  ROOT_CATEGORY,
  OTHER_CATEGORY
} from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const REFERENCE = '60000000-0000-4000-8000-000000000059'
const REASON = 'Synthetic typed attribute editorial review'
const EMPTY: CatalogTypedAttributeValues = { version: 1, values: [] }
const ORIGINAL = { attrs: [{ k: 'Legacy', v: 'Unchanged' }], badges: ['eco'], unknown: { nested: [false, null, 7] } }

describe('governed D1 typed product values using the metadata ledger', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    for (const migration of ['0058_catalog_typed_attributes', '0059_catalog_typed_attribute_values']) {
      if (
        migration.startsWith('0058') &&
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_typed_attribute_commands'").get()
      )
        continue
      if (
        migration.startsWith('0059') &&
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_draft_commands_typed_shape'").get()
      )
        continue
      sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${migration}.sql`, import.meta.url), 'utf8'))
    }
    seedInventoryFixture(sqlite)
    sqlite
      .prepare("UPDATE products SET category_id=?,status='draft',attributes=? WHERE id='p-1'")
      .run(ROOT_CATEGORY, JSON.stringify(ORIGINAL))
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES(?,59,?,'Synthetic referenced product','typed-reference','published')"
      )
      .run(REFERENCE, ROOT_CATEGORY)
    sqlite
      .prepare(
        "INSERT INTO variants(id,product_id,legacy_id,sku,format,status,tax_class_id,shipping_profile_id,price_gross_cents) VALUES('typed-reference-variant',?,590,'TYPED-REF','Unit','published','t21','sp1',100)"
      )
      .run(REFERENCE)
    await provisionPublicationValidityFixture(database, { productIds: [REFERENCE] })
  })
  afterEach(() => sqlite?.close())
  const product = () => sqlite.prepare("SELECT * FROM products WHERE id='p-1'").get()!
  const version = () => Number(product().catalog_version)
  const input = (typed: CatalogTypedAttributeValues = EMPTY) => ({ expectedVersion: version(), reason: REASON, typed })
  const write = (
    body: unknown = input(),
    options: { key?: string; db?: D1Database; claims?: typeof CATEGORY_CLAIMS | null } = {}
  ) =>
    updateD1CatalogTypedAttributeValues(
      options.db ?? database,
      options.claims === undefined ? CATEGORY_CLAIMS : options.claims,
      '1',
      body,
      { idempotencyKey: options.key ?? crypto.randomUUID() }
    )
  async function definition(
    kind = 'text',
    config: unknown = { maxLength: 500 },
    code = `field_${crypto.randomUUID().replaceAll('-', '')}`
  ) {
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CATEGORY_CLAIMS,
        'create',
        {},
        {
          categoryId: 10,
          code,
          kind,
          label: 'Synthetic definition',
          config,
          expectedVersion: 0,
          reason: REASON
        },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).definition
  }
  const typed = (definition: CatalogTypedAttributeDefinition, value: unknown): CatalogTypedAttributeValues =>
    ({
      version: 1,
      values: [{ definitionId: definition.id, revision: definition.revision, value }]
    }) as CatalogTypedAttributeValues
  const counts = () =>
    sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM catalog_draft_commands) commands,
    (SELECT count(*) FROM catalog_draft_audit) audits,(SELECT count(*) FROM catalog_draft_guards) guards`
      )
      .get()
  function batchProxy(before: () => void | Promise<void>): D1Database {
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
  async function rejected(body: unknown, code: string, options: Parameters<typeof write>[1] = {}) {
    const before = product(),
      ledger = counts()
    await expect(write(body, options)).rejects.toMatchObject({ code })
    expect(product()).toEqual(before)
    expect(counts()).toEqual(ledger)
  }
  it('reads private current definitions and an absent namespace without rewriting legacy attributes', async () => {
    const d = await definition()
    const view = await readD1CatalogTypedAttributeProduct(database, CATEGORY_CLAIMS, '1')
    expect(catalogTypedAttributeProductViewSchema.parse(view)).toEqual(view)
    expect(view).toMatchObject({ typed: EMPTY, definitions: [d], capabilities: { read: true, update: true } })
    expect(JSON.parse(String(product().attributes))).toEqual(ORIGINAL)
  })
  it.each([
    ['text', { maxLength: 500 }, '  Español 😀  '],
    ['number', { precision: 2 }, 0],
    ['unit', { precision: 2, units: ['ml', 'l'] }, { quantity: 0.25, unit: 'l' }],
    ['boolean', {}, false],
    ['list', { options: [{ code: 'blue', label: 'Azul', status: 'active' }] }, ['blue']],
    ['reference', {}, REFERENCE]
  ])('writes exact %s values, a durable receipt and per-command audit atomically', async (kind, config, value) => {
    const d = await definition(String(kind), config),
      body = input(typed(d, value)),
      oldVersion = version()
    const statements: string[] = []
    let batchFailure: unknown
    const monitored = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            statements.push(sql)
            return database.prepare(sql)
          }
        if (key === 'batch')
          return async (batch: D1PreparedStatement[]) => {
            try {
              return await database.batch(batch)
            } catch (error) {
              batchFailure = error
              throw error
            }
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const result = await write(body, { db: monitored }).catch((error: unknown) => {
      throw new Error(`Synthetic batch failure: ${String(batchFailure)}`, { cause: error })
    })
    expect(Math.max(...statements.map((sql) => new TextEncoder().encode(sql).byteLength))).toBeLessThanOrEqual(100_000)
    expect(catalogTypedAttributeValuesReceiptSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({
      action: 'update_values',
      productId: 1,
      catalogVersion: oldVersion + 1,
      typed: body.typed
    })
    expect(JSON.parse(String(product().attributes))).toEqual({ ...ORIGINAL, typed: body.typed })
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    const command = sqlite.prepare('SELECT * FROM catalog_draft_commands').get()!
    const audit = sqlite.prepare('SELECT * FROM catalog_draft_audit').get()!
    expect(command.response).toBe(JSON.stringify(result))
    expect(JSON.parse(String(command.before_metadata))).toHaveProperty('typed', null)
    expect(JSON.parse(String(command.before_metadata))).toHaveProperty('typedPresent', false)
    expect(JSON.parse(String(command.after_metadata))).toHaveProperty('typed', body.typed)
    expect(audit.before_metadata).toBe(command.before_metadata)
    expect(audit.after_metadata).toBe(command.after_metadata)
  })
  it('replays the original receipt after a definition is retired, but rejects changed payloads', async () => {
    const d = await definition(),
      body = input(typed(d, 'Original')),
      key = crypto.randomUUID()
    const receipt = await write(body, { key })
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: d.id },
      { expectedVersion: 1, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(await write(body, { key })).toEqual(receipt)
    await rejected({ ...body, typed: typed(d, 'Different') }, 'idempotency_conflict', { key })
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
  it('requires fresh authorization for private reads and replay, including MFA and revocation', async () => {
    const body = input(),
      key = crypto.randomUUID()
    await write(body, { key })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
    await expect(readD1CatalogTypedAttributeProduct(database, CATEGORY_CLAIMS, '1')).rejects.toMatchObject({
      code: 'mfa_required'
    })
    await rejected(body, 'mfa_required', { key })
    sqlite
      .prepare("UPDATE auth_sessions SET mfa_verified=1,revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
      .run(CATEGORY_SESSION)
    await rejected(body, 'unauthenticated', { key })
  })
  it('rejects anonymous reads and stale CAS or non-draft writes without effects', async () => {
    await expect(readD1CatalogTypedAttributeProduct(database, null, '1')).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    await rejected({ ...input(), expectedVersion: version() + 1 }, 'version_conflict')
    sqlite.exec("UPDATE products SET status='review' WHERE id='p-1'")
    await rejected(input(), 'product_not_editable')
  })
  it('preserves explicitly unchanged historical values after retirement and allows removal, never changed reuse', async () => {
    const d = await definition(),
      original = typed(d, 'Historical')
    await write(input(original))
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: d.id },
      { expectedVersion: 1, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    )
    const view = await readD1CatalogTypedAttributeProduct(database, CATEGORY_CLAIMS, '1')
    expect(view.definitions).toContainEqual(d)
    expect(await write(input(original))).toMatchObject({ typed: original })
    await rejected(input(typed(d, 'Changed')), 'invalid_typed_values')
    await write(input())
  })
  it('requires the current revision for new values and rejects precision, duplicate and wrong category entries', async () => {
    const d = await definition('number', { precision: 1 })
    await rejected(input(typed(d, 0.30000000000000004)), 'invalid_typed_values')
    await rejected(input({ version: 1, values: [...typed(d, 1).values, ...typed(d, 1).values] }), 'invalid_input')
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'update',
      { definitionId: d.id },
      { label: 'Revised', config: { precision: 2 }, expectedVersion: 1, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    )
    await rejected(input(typed(d, 1)), 'invalid_typed_values')
    sqlite.prepare("UPDATE products SET category_id=? WHERE id='p-1'").run(OTHER_CATEGORY)
    await rejected(input(typed({ ...d, revision: 2 }, 1)), 'invalid_typed_values')
  })
  it('rejects new hidden and missing references, and detects reference withdrawal at batch execution', async () => {
    const d = await definition('reference', {})
    await rejected(input(typed(d, crypto.randomUUID())), 'reference_unavailable')
    const self = crypto.randomUUID(),
      beforeSelf = counts()
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES(?,60,?,'Synthetic self-reference','typed-self','draft')"
      )
      .run(self, ROOT_CATEGORY)
    await expect(
      updateD1CatalogTypedAttributeValues(
        database,
        CATEGORY_CLAIMS,
        '60',
        { expectedVersion: 1, reason: REASON, typed: typed(d, self) },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toMatchObject({ code: 'invalid_typed_values' })
    expect(counts()).toEqual(beforeSelf)
    sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(REFERENCE)
    await rejected(input(typed(d, REFERENCE)), 'reference_unavailable')
    sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(REFERENCE)
    const before = counts()
    await expect(
      write(input(typed(d, REFERENCE)), {
        db: batchProxy(() => {
          sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(REFERENCE)
        })
      })
    ).rejects.toMatchObject({ code: 'reference_unavailable' })
    expect(counts()).toEqual(before)
    expect(JSON.parse(String(product().attributes))).toEqual(ORIGINAL)
  })
  it('requires a published reference variant with a safe legacy ID before and during the batch', async () => {
    const d = await definition('reference', {})
    sqlite.exec("UPDATE variants SET status='draft' WHERE id='typed-reference-variant'")
    await rejected(input(typed(d, REFERENCE)), 'reference_unavailable')
    sqlite.exec("UPDATE variants SET status='published',legacy_id=NULL WHERE id='typed-reference-variant'")
    await rejected(input(typed(d, REFERENCE)), 'reference_unavailable')
    sqlite.exec("UPDATE variants SET legacy_id=590 WHERE id='typed-reference-variant'")
    await rejected(input(typed(d, REFERENCE)), 'reference_unavailable', {
      db: batchProxy(() => {
        sqlite.exec("UPDATE variants SET status='draft' WHERE id='typed-reference-variant'")
      })
    })
  })
  it('rolls back on definition retirement or actor loss between preflight and batch', async () => {
    const d = await definition()
    await rejected(input(typed(d, 'Synthetic')), 'invalid_typed_values', {
      db: batchProxy(async () => {
        await executeD1CatalogTypedAttributeDefinitionCommand(
          database,
          CATEGORY_CLAIMS,
          'retire',
          { definitionId: d.id },
          { expectedVersion: 1, reason: REASON },
          { idempotencyKey: crypto.randomUUID() }
        )
      })
    })
    const active = await definition()
    let fired = false
    const db = batchProxy(() => {
      if (fired) return
      fired = true
      sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
    })
    await rejected(input(typed(active, 'Synthetic')), 'mfa_required', { db })
  })
  it('rejects category changes carrying old typed values but permits explicit atomic clearing', async () => {
    const d = await definition()
    await write(input(typed(d, 'Keep only in this category')))
    const before = product(),
      ledger = counts()
    await expect(
      updateD1DraftProductMetadata(
        database,
        CATEGORY_CLAIMS,
        '1',
        { expectedVersion: version(), reason: REASON, categoryId: 12 },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toMatchObject({ code: 'invalid_typed_values' })
    expect(product()).toEqual(before)
    expect(counts()).toEqual(ledger)
    await updateD1DraftProductMetadata(
      database,
      CATEGORY_CLAIMS,
      '1',
      { expectedVersion: version(), reason: REASON, categoryId: 12, typed: EMPTY },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(product().category_id).toBe(OTHER_CATEGORY)
    expect(JSON.parse(String(product().attributes))).toEqual({ ...ORIGINAL, typed: EMPTY })
  })
  it('preserves the exact metadata-only receipt and audit shape', async () => {
    const result = await updateD1DraftProductMetadata(
      database,
      CATEGORY_CLAIMS,
      '1',
      { expectedVersion: version(), reason: REASON, name: 'Changed editorial title' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(Object.keys(result)).toEqual(['source', 'productId', 'productUuid', 'catalogVersion', 'updated'])
    expect(
      JSON.parse(String(sqlite.prepare('SELECT before_metadata FROM catalog_draft_commands').get()!.before_metadata))
    ).not.toHaveProperty('typed')
  })
  it('rolls back all product/ledger changes when the final audit is ignored', async () => {
    const d = await definition()
    sqlite.exec(
      'CREATE TRIGGER reject_typed_audit BEFORE INSERT ON catalog_draft_audit BEGIN SELECT RAISE(IGNORE); END'
    )
    await rejected(input(typed(d, 'Synthetic')), 'conflict')
  })
  it('retains exact historical unit values despite insignificant JSON object property order', async () => {
    const d = await definition('unit', { precision: 2, units: ['l'] })
    const namespace = typed(d, { quantity: 0.25, unit: 'l' })
    sqlite.prepare("UPDATE products SET attributes=? WHERE id='p-1'").run(
      JSON.stringify({
        ...ORIGINAL,
        typed: { version: 1, values: [{ definitionId: d.id, revision: 1, value: { unit: 'l', quantity: 0.25 } }] }
      })
    )
    await executeD1CatalogTypedAttributeDefinitionCommand(
      database,
      CATEGORY_CLAIMS,
      'retire',
      { definitionId: d.id },
      { expectedVersion: 1, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(await write(input(namespace))).toMatchObject({ typed: namespace })
  })
  it('never grandfathers entries from a malformed previous namespace during a retirement race', async () => {
    const d = await definition(),
      namespace = typed(d, 'Synthetic old value')
    sqlite.prepare("UPDATE products SET attributes=? WHERE id='p-1'").run(
      JSON.stringify({
        ...ORIGINAL,
        typed: { version: 1, values: [...namespace.values, { invalid: true }] }
      })
    )
    await rejected(input(namespace), 'invalid_typed_values', {
      db: batchProxy(async () => {
        await executeD1CatalogTypedAttributeDefinitionCommand(
          database,
          CATEGORY_CLAIMS,
          'retire',
          { definitionId: d.id },
          { expectedVersion: 1, reason: REASON },
          { idempotencyKey: crypto.randomUUID() }
        )
      })
    })
  })
  it.each([
    ['boolean', false],
    ['number', 0],
    ['text', 'Legacy typed scalar'],
    ['array', ['legacy']],
    ['null', null]
  ])('repairs explicit malformed %s namespace and audits its exact presence/value', async (_kind, malformed) => {
    sqlite
      .prepare("UPDATE products SET attributes=? WHERE id='p-1'")
      .run(JSON.stringify({ ...ORIGINAL, typed: malformed }))
    await write(input())
    expect(JSON.parse(String(product().attributes))).toEqual({ ...ORIGINAL, typed: EMPTY })
    const command = sqlite.prepare('SELECT before_metadata,after_metadata FROM catalog_draft_commands').get()!
    expect(JSON.parse(String(command.before_metadata))).toMatchObject({ typedPresent: true, typed: malformed })
    expect(JSON.parse(String(command.after_metadata))).toMatchObject({ typedPresent: true, typed: EMPTY })
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
})
