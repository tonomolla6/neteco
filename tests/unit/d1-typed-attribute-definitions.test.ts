import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeD1CatalogTypedAttributeDefinitionCommand,
  readD1CatalogTypedAttributeDefinitions
} from '../../workers/catalog/typed-attribute-definitions'
import {
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeReceiptSchema
} from '../../shared/catalog-typed-attributes'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  CATEGORY_SESSION,
  ROOT_CATEGORY
} from '../support/category-command-fixture'
import { testUuid } from '../support/deterministic'

describe('D1 category typed attribute definitions are governed and atomic', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_typed_attribute_definitions'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
  })
  afterEach(() => {
    sqlite?.close()
    vi.restoreAllMocks()
  })
  const body = () => ({
    categoryId: 10,
    code: 'finish',
    kind: 'text',
    label: 'Acabado',
    config: { maxLength: 500 },
    expectedVersion: 0,
    reason: 'Definición sintética de categoría'
  })
  function execute(
    action: 'create' | 'update' | 'retire',
    target: { definitionId?: string },
    input: unknown,
    options: { key?: string; db?: D1Database; claims?: typeof CATEGORY_CLAIMS | null } = {}
  ) {
    return executeD1CatalogTypedAttributeDefinitionCommand(
      options.db ?? database,
      options.claims === undefined ? CATEGORY_CLAIMS : options.claims,
      action,
      target,
      input,
      { idempotencyKey: options.key ?? testUuid() }
    )
  }
  const create = (
    input: unknown = body(),
    options: { key?: string; db?: D1Database; claims?: typeof CATEGORY_CLAIMS | null } = {}
  ) => execute('create', {}, input, options)
  const state = () =>
    [
      'catalog_typed_attribute_definitions',
      'catalog_typed_attribute_revisions',
      'catalog_typed_attribute_commands',
      'catalog_typed_attribute_audit',
      'catalog_typed_attribute_guards',
      'categories',
      'role_permissions',
      'identity_roles'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())
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
  function migrationCommand(overrides: Record<string, unknown> = {}) {
    const id = '80000000-0000-4000-8000-000000000058'
    const definition = catalogTypedAttributeDefinitionSchema.parse({
      id: '70000000-0000-4000-8000-000000000058',
      categoryId: 10,
      categoryUuid: ROOT_CATEGORY,
      code: 'migration_fixture',
      kind: 'text',
      label: 'Definición fixture',
      revision: 1,
      status: 'active',
      config: { maxLength: 500 }
    })
    return {
      id,
      claim_nonce: '90000000-0000-4000-8000-000000000058',
      actor_id: CATEGORY_IDENTITY,
      action: 'create',
      definition_id: definition.id,
      category_id: ROOT_CATEGORY,
      expected_revision: 0,
      result_revision: 1,
      reason: body().reason,
      input: JSON.stringify({ ...body(), code: definition.code, label: definition.label }),
      before_state: null,
      after_state: JSON.stringify(definition),
      response: JSON.stringify({ source: 'cloudflare', action: 'create', commandId: id, definition, updated: true }),
      idempotency_key: 'synthetic-migration-fixture',
      payload_hash: 'a'.repeat(64),
      created_at: '2026-10-08T00:00:00Z',
      ...overrides
    }
  }
  function insertMigrationCommand(row = migrationCommand()) {
    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_commands(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...(Object.values(row) as never[]))
  }
  function migrationFixture() {
    const command = migrationCommand()
    insertMigrationCommand(command)
    const definition = JSON.parse(String(command.after_state))
    sqlite
      .prepare('INSERT INTO catalog_typed_attribute_definitions VALUES(?,?,?,?,?,?,?,?)')
      .run(
        definition.id,
        ROOT_CATEGORY,
        definition.code,
        definition.kind,
        1,
        'active',
        command.created_at,
        command.created_at
      )
    sqlite
      .prepare('INSERT INTO catalog_typed_attribute_revisions VALUES(?,?,?,?,?,?,?)')
      .run(
        definition.id,
        1,
        definition.label,
        'active',
        JSON.stringify(definition.config),
        command.created_at,
        command.id
      )
    const columns = [
      'actor_id',
      'action',
      'definition_id',
      'category_id',
      'expected_revision',
      'result_revision',
      'reason',
      'input',
      'before_state',
      'after_state',
      'response',
      'created_at'
    ] as const
    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_audit(id,command_id,${columns.join(',')}) VALUES(${Array.from({ length: columns.length + 2 }, () => '?').join(',')})`
      )
      .run(command.id, command.id, ...(columns.map((column) => command[column]) as never[]))
  }
  it.each(['definitions', 'revisions', 'commands', 'audit'])(
    'rejects INSERT OR REPLACE of immutable %s with recursive triggers OFF',
    (suffix) => {
      sqlite.exec('PRAGMA recursive_triggers=OFF')
      migrationFixture()
      const before = state(),
        table = `catalog_typed_attribute_${suffix}`
      expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow()
      expect(state()).toEqual(before)
    }
  )
  it('rejects malformed command identity, timestamp, key, reason, hash and response bindings at the SQL boundary', () => {
    const valid = migrationCommand()
    for (const patch of [
      { id: 'short' },
      { claim_nonce: 'short' },
      { idempotency_key: '' },
      { reason: 'no' },
      { payload_hash: `${'a'.repeat(63)}z` },
      { created_at: 'not-an-instant' },
      { created_at: '' },
      { created_at: '2026-02-30T00:00:00Z' },
      {
        response: JSON.stringify({ ...JSON.parse(valid.response), commandId: '90000000-0000-4000-8000-000000000058' })
      },
      { after_state: JSON.stringify({ ...JSON.parse(valid.after_state), revision: 2 }) }
    ])
      expect(() => insertMigrationCommand(migrationCommand(patch))).toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
  })
  it('uses STRICT tables for the new durable records', () => {
    const rows = sqlite
      .prepare("SELECT name,strict FROM pragma_table_list WHERE name LIKE 'catalog_typed_attribute_%'")
      .all()
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.strict === 1)).toBe(true)
  })
  it('creates an explicit category definition, exact durable receipt and NULL-before audit in one batch', async () => {
    const result = await create()
    expect(catalogTypedAttributeReceiptSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({
      source: 'cloudflare',
      action: 'create',
      updated: true,
      definition: {
        categoryId: 10,
        code: 'finish',
        kind: 'text',
        revision: 1,
        status: 'active',
        config: { maxLength: 500 }
      }
    })
    expect(await readD1CatalogTypedAttributeDefinitions(database, 10)).toEqual([result.definition])
    const command = sqlite.prepare('SELECT * FROM catalog_typed_attribute_commands').get()!
    const audit = sqlite.prepare('SELECT * FROM catalog_typed_attribute_audit').get()!
    expect(command.before_state).toBeNull()
    expect(audit.before_state).toBeNull()
    expect(command.after_state).toBe(JSON.stringify(result.definition))
    expect(audit.after_state).toBe(command.after_state)
    expect(JSON.parse(String(command.response))).toEqual(result)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_guards').get()).toEqual({ n: 0 })
  })
  it('keeps immutable revision history and old replay outcome after later edits and retirement', async () => {
    const key = testUuid(),
      initial = await create(body(), { key })
    const next = await execute(
      'update',
      { definitionId: initial.definition.id },
      {
        label: 'Acabado renovado',
        config: { maxLength: 20 },
        expectedVersion: 1,
        reason: 'Presentación y límite revisados'
      }
    )
    expect(next.definition.revision).toBe(2)
    const retired = await execute(
      'retire',
      { definitionId: initial.definition.id },
      { expectedVersion: 2, reason: 'Retirada editorial no destructiva' }
    )
    expect(retired.definition).toMatchObject({ revision: 3, status: 'retired', config: { maxLength: 20 } })
    expect(await readD1CatalogTypedAttributeDefinitions(database, 10)).toEqual([])
    expect(await readD1CatalogTypedAttributeDefinitions(database, 10, { historical: true })).toEqual([
      initial.definition,
      next.definition,
      retired.definition
    ])
    expect(await create(body(), { key })).toEqual(initial)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 3 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_audit').get()).toEqual({ n: 3 })
    for (const table of [
      'catalog_typed_attribute_definitions',
      'catalog_typed_attribute_revisions',
      'catalog_typed_attribute_commands',
      'catalog_typed_attribute_audit'
    ])
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
    expect(() => sqlite.exec("UPDATE catalog_typed_attribute_revisions SET label='changed' WHERE revision=1")).toThrow()
  })
  it('rejects stale versions, target identity changes, wrong config and reused idempotency bodies without effects', async () => {
    const key = testUuid(),
      initial = await create(body(), { key }),
      before = state()
    await expect(create({ ...body(), label: 'Different label' }, { key })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        { label: 'Cambio', config: { maxLength: 10 }, expectedVersion: 2, reason: 'Edición de versión obsoleta' }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        { label: 'Cambio', config: { precision: 2 }, expectedVersion: 1, reason: 'No cambia tipo ni contrato' }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        {
          label: 'Cambio',
          code: 'different',
          config: { maxLength: 10 },
          expectedVersion: 1,
          reason: 'No cambia identidad estable'
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(state()).toEqual(before)
  })
  it('reserves category codes permanently and rejects missing categories', async () => {
    const initial = await create()
    await execute(
      'retire',
      { definitionId: initial.definition.id },
      { expectedVersion: 1, reason: 'Retirada sin reutilizar códigos' }
    )
    const before = state()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    await expect(create({ ...body(), categoryId: 99999 })).rejects.toMatchObject({ code: 'reference_unavailable' })
    expect(state()).toEqual(before)
  })
  it('keeps options as retired instead of deleting/reusing codes while permitting presentation labels', async () => {
    const options = [
      { code: 'matte', label: 'Mate', status: 'active' },
      { code: 'gloss', label: 'Brillo', status: 'active' }
    ]
    const initial = await create({ ...body(), kind: 'list', config: { options } })
    const before = state()
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        {
          label: 'Acabado',
          config: { options: [options[0]] },
          expectedVersion: 1,
          reason: 'No borrar opción histórica'
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_config_transition' })
    expect(state()).toEqual(before)
    const updated = await execute(
      'update',
      { definitionId: initial.definition.id },
      {
        label: 'Acabado',
        config: {
          options: [
            { ...options[0], label: 'Mate suave' },
            { ...options[1], status: 'retired' }
          ]
        },
        expectedVersion: 1,
        reason: 'Etiqueta y retirada de opción'
      }
    )
    const frozen = state()
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        {
          label: 'Acabado',
          config: { options },
          expectedVersion: updated.definition.revision,
          reason: 'No reactivar otro significado'
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_config_transition' })
    expect(state()).toEqual(frozen)
  })
  it('limits each category to 32 definitions including retired, without unrelated grants or products', async () => {
    const protectedBefore = ['products', 'role_permissions', 'identity_roles'].map((table) =>
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    )
    for (let index = 0; index < 32; index++) await create({ ...body(), code: `field_${index}` })
    const before = state()
    await expect(create({ ...body(), code: 'overflow' })).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
    expect(
      ['products', 'role_permissions', 'identity_roles'].map((table) =>
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
      )
    ).toEqual(protectedBefore)
  })
  it('requires live authority and MFA even for durable replay', async () => {
    const key = testUuid()
    await create(body(), { key })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
    const before = state()
    await expect(create(body(), { key })).rejects.toMatchObject({ code: 'mfa_required' })
    expect(state()).toEqual(before)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(CATEGORY_SESSION)
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CATEGORY_IDENTITY)
    await expect(create(body(), { key })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(create(body(), { claims: null })).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('checks authority again inside D1 SQL when permission is revoked between preflight and batch', async () => {
    const proxy = batchProxy(() => {
      sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CATEGORY_IDENTITY)
    })
    await expect(create(body(), { db: proxy })).rejects.toMatchObject({ code: 'forbidden' })
    for (const table of [
      'catalog_typed_attribute_definitions',
      'catalog_typed_attribute_revisions',
      'catalog_typed_attribute_commands',
      'catalog_typed_attribute_audit',
      'catalog_typed_attribute_guards'
    ])
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
  })
  it('requires the catalog grant as well as administration for creation and durable replay', async () => {
    const key = testUuid()
    await create(body(), { key })
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    const before = state()
    await expect(create(body(), { key })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(create({ ...body(), code: 'new_field' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(state()).toEqual(before)
  })
  it('rolls back if only the catalog grant is revoked after prechecks but before the batch', async () => {
    const proxy = batchProxy(() => {
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    })
    await expect(create(body(), { db: proxy })).rejects.toMatchObject({ code: 'forbidden' })
    for (const table of ['definitions', 'revisions', 'commands', 'audit', 'guards'])
      expect(sqlite.prepare(`SELECT count(*) AS n FROM catalog_typed_attribute_${table}`).get()).toEqual({ n: 0 })
  })
  it('rolls back command/header/revision/receipt on a late audit failure', async () => {
    sqlite.exec(
      "CREATE TRIGGER typed_test_late BEFORE INSERT ON catalog_typed_attribute_audit BEGIN SELECT RAISE(ABORT,'synthetic_late_audit'); END"
    )
    const before = state()
    await expect(create()).rejects.toThrow()
    expect(state()).toEqual(before)
  })
  it('detects ignored revision writes and audit replacements with non-NULL creation before-state', async () => {
    sqlite.exec(
      'CREATE TRIGGER typed_test_ignore BEFORE INSERT ON catalog_typed_attribute_revisions BEGIN SELECT RAISE(IGNORE); END'
    )
    const before = state()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
    sqlite.exec('DROP TRIGGER typed_test_ignore')
    sqlite.exec(`CREATE TRIGGER typed_test_before BEFORE INSERT ON catalog_typed_attribute_audit WHEN NEW.before_state IS NULL BEGIN
      INSERT INTO catalog_typed_attribute_audit(id,command_id,actor_id,action,definition_id,category_id,expected_revision,result_revision,reason,input,before_state,after_state,response,created_at)
      VALUES(NEW.id,NEW.command_id,NEW.actor_id,NEW.action,NEW.definition_id,NEW.category_id,NEW.expected_revision,NEW.result_revision,NEW.reason,NEW.input,'{}',NEW.after_state,NEW.response,NEW.created_at);
      SELECT RAISE(IGNORE); END`)
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
  })
  it('detects an update audit losing its exact non-NULL prior snapshot', async () => {
    const initial = await create()
    sqlite.exec(`CREATE TRIGGER typed_test_update_before BEFORE INSERT ON catalog_typed_attribute_audit WHEN NEW.before_state IS NOT NULL BEGIN
      INSERT INTO catalog_typed_attribute_audit(id,command_id,actor_id,action,definition_id,category_id,expected_revision,result_revision,reason,input,before_state,after_state,response,created_at)
      VALUES(NEW.id,NEW.command_id,NEW.actor_id,NEW.action,NEW.definition_id,NEW.category_id,NEW.expected_revision,NEW.result_revision,NEW.reason,NEW.input,NULL,NEW.after_state,NEW.response,NEW.created_at);
      SELECT RAISE(IGNORE); END`)
    const before = state()
    await expect(
      execute(
        'update',
        { definitionId: initial.definition.id },
        { label: 'Nuevo título', config: { maxLength: 100 }, expectedVersion: 1, reason: 'Cambio editorial sintético' }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
  })
  it('rejects a concurrent loser without changing the winner or appending a phantom command', async () => {
    const initial = await create()
    const winner = {
      label: 'Ganador',
      config: { maxLength: 10 },
      expectedVersion: 1,
      reason: 'Cambio concurrente ganador'
    }
    let count = 0
    const proxy = batchProxy(async () => {
      if (count++ === 0) await execute('update', { definitionId: initial.definition.id }, winner)
    })
    await expect(
      execute('update', { definitionId: initial.definition.id }, { ...winner, label: 'Perdedor' }, { db: proxy })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect((await readD1CatalogTypedAttributeDefinitions(database, 10))[0]).toMatchObject({
      label: 'Ganador',
      revision: 2
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_audit').get()).toEqual({ n: 2 })
  })
})
