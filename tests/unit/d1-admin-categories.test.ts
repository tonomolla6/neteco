import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeD1CatalogCategoryCommand } from '../../workers/catalog/admin-categories'
import { listD1AdminCategories } from '../../workers/catalog/admin-catalog'
import { parseD1CategoryAdminView } from '../../shared/catalog-category-commands'
import {
  createCategoryInputSchema,
  updateCategoryInputSchema,
  deleteCategoryInputSchema,
  catalogCategoryReceiptSchema,
  type CatalogCategoryAction
} from '../../shared/catalog-category-commands'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  CATEGORY_SESSION,
  ROOT_CATEGORY,
  CHILD_CATEGORY,
  OTHER_CATEGORY,
  categoryUtc
} from '../support/category-command-fixture'
import { testUuid, testNow } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      sqlite.function('synthetic_categories_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_categories_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_categories_clock()'))
      return database
    }
  }
})

describe('D1 category editorial commands are atomic and never publish', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    ;({ sqlite, database } = await categoryCommandFixture())
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const createBody = () => ({ name: 'Nueva familia', expectedVersion: 0, reason: 'Alta editorial sintética' })
  const updateBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Familia renovada',
    expectedVersion: 1,
    reason: 'Edición editorial sintética',
    ...extra
  })
  function execute(
    action: CatalogCategoryAction,
    target: { categoryId?: string },
    input: unknown,
    options: { key?: string; db?: D1Database; claims?: typeof CATEGORY_CLAIMS | null; now?: string } = {}
  ) {
    return executeD1CatalogCategoryCommand(
      options.db ?? database,
      options.claims === undefined ? CATEGORY_CLAIMS : options.claims,
      action,
      target,
      input,
      { idempotencyKey: options.key ?? testUuid(), ...(options.now === undefined ? {} : { now: options.now }) }
    )
  }
  const create = (body: unknown = createBody(), options: { key?: string; db?: D1Database } = {}) =>
    execute('create_category', {}, body, options)
  const update = (id = '11', body: unknown = updateBody(), options: { key?: string; db?: D1Database } = {}) =>
    execute('update_category', { categoryId: id }, body, options)
  const remove = (
    id = '12',
    body: unknown = { expectedVersion: 1, reason: 'Retirada editorial sintética' },
    options: { key?: string; db?: D1Database } = {}
  ) => execute('delete_category', { categoryId: id }, body, options)
  function state() {
    return [
      'categories',
      'catalog_category_counter',
      'catalog_category_aliases',
      'catalog_category_commands',
      'catalog_category_audit',
      'catalog_category_guards'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  }
  function proxy(overrides: Partial<Pick<D1Database, 'prepare' | 'batch'>>): D1Database {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare' && overrides.prepare) return overrides.prepare
        if (key === 'batch' && overrides.batch) return overrides.batch
        return Reflect.get(target, key, receiver)
      }
    })
  }
  it('creates one mapped draft with version1, bounded legacy identity and immutable matching audit', async () => {
    const result = await create()
    expect(catalogCategoryReceiptSchema.parse(result)).toEqual({
      source: 'cloudflare',
      action: 'create_category',
      categoryId: 1000,
      categoryUuid: expect.any(String),
      categoryVersion: 1,
      slug: 'nueva-familia',
      status: 'draft',
      updated: true
    })
    const row = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(result.categoryUuid)
    expect(row).toMatchObject({ legacy_id: 1000, status: 'draft', category_version: 1, parent_id: null })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 1 })
    const command = sqlite.prepare('SELECT * FROM catalog_category_commands').get()!
    const audit = sqlite.prepare('SELECT * FROM catalog_category_audit').get()!
    for (const key of [
      'actor_id',
      'action',
      'target',
      'input',
      'category_id',
      'category_uuid',
      'expected_version',
      'result_version',
      'reason',
      'before_graph',
      'before_state',
      'after_state',
      'response',
      'created_at'
    ])
      expect(audit[key]).toEqual(command[key])
    expect(JSON.parse(String(command.after_state))).toEqual(row)
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_guards').get()).toEqual({ total: 0 })
  })
  it.each(['draft', 'review', 'published', 'hidden'])(
    'allows a new draft beneath a mapped %s parent without changing its state',
    async (status) => {
      sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, OTHER_CATEGORY)
      const result = await create({ ...createBody(), parentId: 12 })
      expect(result.status).toBe('draft')
      expect(sqlite.prepare('SELECT parent_id FROM categories WHERE id=?').get(result.categoryUuid)).toEqual({
        parent_id: OTHER_CATEGORY
      })
      expect(sqlite.prepare('SELECT status FROM categories WHERE id=?').get(OTHER_CATEGORY)).toEqual({ status })
    }
  )
  it('increments highwater after external high IDs, and never reuses IDs after external deletion/tombstone', async () => {
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES ('external-high',5000,'Externa alta','externa-alta','draft')"
      )
      .run()
    sqlite.exec("DELETE FROM categories WHERE id='external-high'")
    const first = await create(),
      second = await create({ ...createBody(), name: 'Segunda familia' })
    expect([first.categoryId, second.categoryId]).toEqual([5001, 5002])
    await remove(String(second.categoryId))
    expect((await create({ ...createBody(), name: 'Tercera familia' })).categoryId).toBe(5003)
  })
  it('renames and preserves every protected category field and exact unmapped parent when parentId is omitted', async () => {
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status) VALUES ('unmapped-parent',NULL,?,'Padre sin mapping','padre-sin-mapping','hidden')"
      )
      .run(ROOT_CATEGORY)
    sqlite
      .prepare(
        "UPDATE categories SET parent_id='unmapped-parent',description='Descripción preservada',seo_title='Título protegido',seo_description='SEO protegido',source_version='import-v2' WHERE id=?"
      )
      .run(CHILD_CATEGORY)
    const before = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(CHILD_CATEGORY)!
    const result = await update('11', updateBody({ expectedVersion: before.category_version }))
    expect(result.categoryVersion).toBe(Number(before.category_version) + 1)
    const after = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(CHILD_CATEGORY)!
    for (const key of [
      'id',
      'legacy_id',
      'parent_id',
      'description',
      'seo_title',
      'seo_description',
      'source_id',
      'source_version',
      'sort_order',
      'created_at',
      'status'
    ])
      expect(after[key]).toEqual(before[key])
    expect(
      sqlite.prepare('SELECT category_uuid FROM catalog_category_aliases WHERE slug=?').get('familia-hija')
    ).toEqual({ category_uuid: CHILD_CATEGORY })
  })
  it('allows a safe move that does not resurrect public visibility', async () => {
    const result = await update('11', updateBody({ parentId: 12 }))
    expect(result.status).toBe('published')
    expect(sqlite.prepare('SELECT parent_id FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      parent_id: OTHER_CATEGORY
    })
  })
  it('preserves unrelated historical signed sort and short names while creating and editing', async () => {
    sqlite
      .prepare(
        "INSERT INTO categories(id,name,slug,status,sort_order) VALUES ('historical-unmapped','X','historical-unmapped','hidden',-2)"
      )
      .run()
    sqlite.prepare("UPDATE categories SET parent_id='historical-unmapped',sort_order=-1 WHERE id=?").run(CHILD_CATEGORY)
    const before = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(CHILD_CATEGORY)!
    await update('11', updateBody({ expectedVersion: before.category_version }))
    expect(sqlite.prepare('SELECT parent_id,sort_order FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      parent_id: 'historical-unmapped',
      sort_order: -1
    })
    expect((await create()).status).toBe('draft')
    expect(sqlite.prepare("SELECT name,sort_order FROM categories WHERE id='historical-unmapped'").get()).toEqual({
      name: 'X',
      sort_order: -2
    })
  })
  it.each([
    { id: '10', parentId: 10 },
    { id: '10', parentId: 11 },
    { id: '11', parentId: 11 }
  ])('rejects self/descendant move %#', async ({ id, parentId }) => {
    const before = state()
    await expect(update(id, updateBody({ parentId }))).rejects.toMatchObject({ code: 'invalid_hierarchy' })
    expect(state()).toEqual(before)
  })
  it.each(['draft', 'review', 'hidden', 'discontinued'])(
    'cannot resurrect a published subtree formerly under %s by moving it to root',
    async (status) => {
      sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, ROOT_CATEGORY)
      const before = state()
      await expect(update('11', updateBody({ parentId: null }))).rejects.toMatchObject({ code: 'visibility_expansion' })
      expect(state()).toEqual(before)
    }
  )
  it('cannot resurrect published descendants below an unmapped published parent', async () => {
    sqlite.prepare('UPDATE categories SET legacy_id=NULL WHERE id=?').run(ROOT_CATEGORY)
    await expect(update('11', updateBody({ parentId: null }))).rejects.toMatchObject({ code: 'visibility_expansion' })
  })
  it('does not silently repair a corrupt pre-existing cycle', async () => {
    sqlite.prepare('UPDATE categories SET parent_id=? WHERE id=?').run(CHILD_CATEGORY, ROOT_CATEGORY)
    await expect(create()).rejects.toThrow('category_source_invalid')
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 0 })
  })
  it.each([999, 13])('rejects absent or unmapped requested parent %s', async (parentId) => {
    await expect(create({ ...createBody(), parentId })).rejects.toMatchObject({ code: 'reference_unavailable' })
  })
  it('rejects a discontinued new parent and does not edit a tombstone', async () => {
    await remove()
    await expect(create({ ...createBody(), parentId: 12 })).rejects.toMatchObject({ code: 'reference_unavailable' })
    await expect(update('12')).rejects.toMatchObject({ code: 'category_not_editable' })
  })
  it('renames through direct UUID aliases, refuses alias theft and supports reverting its own former slug', async () => {
    const first = await update(),
      second = await update('11', updateBody({ name: 'Familia final', expectedVersion: 2 }))
    expect([first.slug, second.slug]).toEqual(['familia-renovada', 'familia-final'])
    expect(sqlite.prepare('SELECT slug,category_uuid FROM catalog_category_aliases ORDER BY slug').all()).toEqual([
      { slug: 'familia-hija', category_uuid: CHILD_CATEGORY },
      { slug: 'familia-renovada', category_uuid: CHILD_CATEGORY }
    ])
    const other = await update('12', updateBody({ name: 'Familia hija' }))
    expect(other.slug).not.toBe('familia-hija')
    const reverted = await update('11', updateBody({ name: 'Familia hija', expectedVersion: 3 }))
    expect(reverted.slug).toBe('familia-hija')
    expect(
      sqlite.prepare("SELECT category_uuid FROM catalog_category_aliases WHERE slug='familia-final'").get()
    ).toEqual({ category_uuid: CHILD_CATEGORY })
  })
  it('tombstones an empty category while preserving immutable identity, aliases and all metadata', async () => {
    await update('12')
    const before = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(OTHER_CATEGORY)!
    const result = await remove('12', { expectedVersion: 2, reason: 'Retirada editorial sintética' })
    expect(result.status).toBe('discontinued')
    const after = sqlite.prepare('SELECT * FROM categories WHERE id=?').get(OTHER_CATEGORY)!
    expect(after).toMatchObject({
      id: OTHER_CATEGORY,
      legacy_id: 12,
      name: before.name,
      slug: before.slug,
      parent_id: null,
      category_version: 3,
      status: 'discontinued'
    })
    expect(sqlite.prepare('SELECT category_uuid FROM catalog_category_aliases').get()).toEqual({
      category_uuid: OTHER_CATEGORY
    })
  })
  it.each(['draft', 'review', 'published', 'hidden', 'discontinued'])(
    'delete rejects a direct child in any state: %s',
    async (status) => {
      sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, CHILD_CATEGORY)
      const current = sqlite.prepare('SELECT category_version FROM categories WHERE id=?').get(ROOT_CATEGORY)!
      await expect(
        remove('10', { expectedVersion: current.category_version, reason: 'Retirada editorial sintética' })
      ).rejects.toMatchObject({ code: 'category_not_empty' })
    }
  )
  it('delete rejects an unmapped child and an unmapped unpublished product', async () => {
    sqlite
      .prepare(
        "INSERT INTO categories(id,parent_id,name,slug,status) VALUES ('unmapped-child',?,'Hija sin mapping','hija-sin-mapping','draft')"
      )
      .run(OTHER_CATEGORY)
    await expect(remove()).rejects.toMatchObject({ code: 'category_not_empty' })
    sqlite.exec("DELETE FROM categories WHERE id='unmapped-child'")
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES ('unmapped-product',NULL,?,'Producto privado','producto-privado','draft')"
      )
      .run(OTHER_CATEGORY)
    await expect(remove()).rejects.toMatchObject({ code: 'category_not_empty' })
  })
  it.each(['name', 'parent', 'status'])(
    'completed replay is exact before later current-state change %s',
    async (change) => {
      const result = await update('11', updateBody(), { key: 'immutable-replay' }),
        beforeCommands = sqlite.prepare('SELECT * FROM catalog_category_commands').all()
      if (change === 'name')
        sqlite.prepare("UPDATE categories SET name='Otro nombre actual' WHERE id=?").run(CHILD_CATEGORY)
      if (change === 'parent')
        sqlite.prepare('UPDATE categories SET parent_id=? WHERE id=?').run(OTHER_CATEGORY, CHILD_CATEGORY)
      if (change === 'status')
        sqlite.prepare("UPDATE categories SET status='discontinued' WHERE id=?").run(CHILD_CATEGORY)
      expect(await update('11', updateBody(), { key: 'immutable-replay' })).toEqual(result)
      expect(sqlite.prepare('SELECT * FROM catalog_category_commands').all()).toEqual(beforeCommands)
      await expect(
        update('11', updateBody({ reason: 'Otra intención distinta' }), { key: 'immutable-replay' })
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    }
  )
  it.each(['grant', 'mfa', 'email', 'session'])(
    'live %s revocation denies both new commands and historical replay',
    async (cause) => {
      await update('11', updateBody(), { key: 'revoked-replay' })
      if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
      if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
      if (cause === 'email')
        sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CATEGORY_IDENTITY)
      if (cause === 'session')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(categoryUtc(), CATEGORY_SESSION)
      const code =
        cause === 'grant'
          ? 'forbidden'
          : cause === 'mfa'
            ? 'mfa_required'
            : cause === 'email'
              ? 'email_unverified'
              : 'unauthenticated'
      await expect(update('11', updateBody(), { key: 'revoked-replay' })).rejects.toMatchObject({ code })
      await expect(create()).rejects.toMatchObject({ code })
    }
  )
  it('a catalog.write-only reader cannot mutate categories', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
    await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('reauthorizes after awaiting an existing receipt before exposing it', async () => {
    await create(createBody(), { key: 'late-replay' })
    const native = database.prepare.bind(database)
    const wrapped = proxy({
      prepare(sql) {
        const statement = native(sql)
        if (!sql.includes('c.payload_hash,c.response')) return statement
        const wrapped = new Proxy(statement, {
          get(target, key, receiver) {
            if (key === 'bind')
              return (...parameters: unknown[]) => {
                statement.bind(...parameters)
                return wrapped
              }
            if (key !== 'first') return Reflect.get(target, key, receiver)
            return async <T>() => {
              const result = await statement.first<T>()
              sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
              return result
            }
          }
        })
        return wrapped
      }
    })
    await expect(create(createBody(), { key: 'late-replay', db: wrapped })).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('live revocation immediately before batch denies and rolls back every claimed effect', async () => {
    const before = state()
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
        return database.batch<T>(statements)
      }
    })
    await expect(update('11', updateBody(), { db: wrapped })).rejects.toMatchObject({ code: 'forbidden' })
    expect(state()).toEqual(before)
  })
  it('execution-time SQL clock rejects a session expiring before batch and rolls back every effect', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(testNow()))
    const expiry = categoryUtc(1000)
    sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(expiry, CATEGORY_SESSION)
    sqlite.function('category_test_now', () => {
      const clock = vi.getMockedSystemTime()
      if (!clock) throw new Error('missing_synthetic_categories_clock')
      return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
    })
    const native = database.prepare.bind(database)
    const wrapped = proxy({
      prepare(sql) {
        return native(sql.replaceAll("'now'", 'category_test_now()'))
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        vi.advanceTimersByTime(2000)
        return database.batch<T>(statements)
      }
    })
    const before = state()
    await expect(update('11', updateBody(), { db: wrapped })).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(state()).toEqual(before)
  })
  it('late state/version drift does not overwrite a concurrent editor', async () => {
    let fired = false
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!fired) {
          fired = true
          sqlite.prepare("UPDATE categories SET description='Concurrent preserved' WHERE id=?").run(CHILD_CATEGORY)
        }
        return database.batch<T>(statements)
      }
    })
    await expect(update('11', updateBody(), { db: wrapped })).rejects.toMatchObject({ code: 'version_conflict' })
    expect(sqlite.prepare('SELECT description,name FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      description: 'Concurrent preserved',
      name: 'Familia hija'
    })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 0 })
  })
  it('late ancestor publication drift cannot resurrect a formerly hidden subtree', async () => {
    sqlite.prepare("UPDATE categories SET status='hidden' WHERE id=?").run(ROOT_CATEGORY)
    let fired = false
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!fired) {
          fired = true
          sqlite.prepare("UPDATE categories SET status='published' WHERE id=?").run(OTHER_CATEGORY)
        }
        return database.batch<T>(statements)
      }
    })
    await expect(update('11', updateBody({ parentId: 12 }), { db: wrapped })).rejects.toMatchObject({
      code: 'visibility_expansion'
    })
    expect(sqlite.prepare('SELECT parent_id FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      parent_id: ROOT_CATEGORY
    })
  })
  it('a product arriving before deletion batch prevents tombstone and rolls back its command', async () => {
    let fired = false
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!fired) {
          fired = true
          sqlite
            .prepare(
              "INSERT INTO products(id,category_id,name,slug,status) VALUES ('late-product',?,'Producto tardío','producto-tardio','hidden')"
            )
            .run(OTHER_CATEGORY)
        }
        return database.batch<T>(statements)
      }
    })
    await expect(remove('12', undefined, { db: wrapped })).rejects.toMatchObject({ code: 'category_not_empty' })
    expect(sqlite.prepare('SELECT status FROM categories WHERE id=?').get(OTHER_CATEGORY)).toEqual({ status: 'draft' })
  })
  it('forced audit failure rolls back category, alias, counter and every ledger entry', async () => {
    sqlite.exec(
      "CREATE TRIGGER forced_category_audit BEFORE INSERT ON catalog_category_audit BEGIN SELECT RAISE(ABORT,'forced audit failure'); END"
    )
    const before = state()
    await expect(update()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
  })
  it('provider failure mentioning CHECK remains infrastructure despite external drift', async () => {
    const wrapped = proxy({
      async batch() {
        sqlite.prepare("UPDATE categories SET description='External preserved' WHERE id=?").run(CHILD_CATEGORY)
        throw new Error('D1_ERROR: provider unavailable; CHECK constraint failed private_table')
      }
    })
    await expect(update('11', updateBody(), { db: wrapped })).rejects.toThrow('provider unavailable')
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 0 })
  })
  it('revocation after the committed batch denies private receipt without claiming rollback', async () => {
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const results = await database.batch<T>(statements)
        sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='administration.manage'").run()
        return results
      }
    })
    await expect(update('11', updateBody(), { db: wrapped, key: 'after-commit-revoke' })).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(sqlite.prepare('SELECT category_version FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      category_version: 2
    })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_audit').get()).toEqual({ total: 1 })
  })
  it.each([
    'inherited-success',
    'accessor-success',
    'missing-results',
    'partial-batch',
    'extra-row',
    'row-hole',
    'row-extra',
    'row-accessor'
  ])('rejects malformed committed provider envelope %s without invoking getters', async (shape) => {
    const calls = vi.fn()
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const results = await database.batch<T>(statements)
        if (shape === 'partial-batch') results.pop()
        else if (shape === 'inherited-success') {
          Object.setPrototypeOf(results[0]!, { success: true })
          Reflect.deleteProperty(results[0]!, 'success')
        } else if (shape === 'accessor-success') Object.defineProperty(results[0]!, 'success', { get: calls })
        else if (shape === 'missing-results') Reflect.deleteProperty(results[0]!, 'results')
        else {
          const selected = results[results.length - 2]!.results
          if (shape === 'extra-row') selected.push(selected[0]!)
          else if (shape === 'row-hole') Reflect.deleteProperty(selected, '0')
          else if (shape === 'row-extra') Object.defineProperty(selected, 'poison', { get: calls })
          else Object.defineProperty(selected, '0', { get: calls, enumerable: true })
        }
        return results
      }
    })
    await expect(update('11', updateBody(), { db: wrapped })).rejects.toThrow('category_write_unavailable')
    expect(calls).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_audit').get()).toEqual({ total: 1 })
  })
  it('same-key identical race executes exactly one audited mutation', async () => {
    let fired = false
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!fired) {
          fired = true
          await update('11', updateBody(), { key: 'race-identical' })
        }
        return database.batch<T>(statements)
      }
    })
    expect(await update('11', updateBody(), { key: 'race-identical', db: wrapped })).toMatchObject({
      categoryVersion: 2
    })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 1 })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_audit').get()).toEqual({ total: 1 })
  })
  it('same-key different payload race never returns the other intention as success', async () => {
    let fired = false
    const wrapped = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!fired) {
          fired = true
          await update('11', updateBody({ name: 'Ganador distinto' }), { key: 'race-distinct' })
        }
        return database.batch<T>(statements)
      }
    })
    await expect(update('11', updateBody(), { key: 'race-distinct', db: wrapped })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(sqlite.prepare('SELECT name FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      name: 'Ganador distinto'
    })
  })
  it('an externally persisted claim without its immutable audit cannot be stolen or replayed as completed', async () => {
    const wrapped = proxy({
      async batch(statements: D1PreparedStatement[]) {
        await statements[0]!.run()
        throw new Error('provider unavailable after external claim')
      }
    })
    await expect(update('11', updateBody(), { db: wrapped, key: 'claimed-only' })).rejects.toThrow(
      'provider unavailable'
    )
    const before = state()
    await expect(update('11', updateBody(), { key: 'claimed-only' })).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
    expect(sqlite.prepare('SELECT category_version,name FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
      category_version: 1,
      name: 'Familia hija'
    })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_audit').get()).toEqual({ total: 0 })
  })
  it('safe-integer identity highwater exhaustion refuses creation without counter or ledger partials', async () => {
    sqlite.prepare('UPDATE catalog_category_counter SET last_id=? WHERE id=1').run(Number.MAX_SAFE_INTEGER)
    const before = state()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(before)
  })
  it.each([0, 1])('immutable ledgers and aliases reject REPLACE even with recursive_triggers=%s', async (recursive) => {
    await update()
    sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
    const before = state()
    for (const table of [
      'catalog_category_commands',
      'catalog_category_audit',
      'catalog_category_aliases',
      'catalog_category_counter'
    ])
      expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow()
    expect(state()).toEqual(before)
  })
  it.each([0, 1])(
    'external substantive updates bump exactly once, noops never increment; recursion=%s',
    async (recursive) => {
      sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
      sqlite.prepare("UPDATE categories SET name=name,updated_at='2026-01-01T00:00:00Z' WHERE id=?").run(CHILD_CATEGORY)
      expect(sqlite.prepare('SELECT category_version FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
        category_version: 1
      })
      sqlite
        .prepare("UPDATE categories SET name='Nombre externo',description='Nueva descripción' WHERE id=?")
        .run(CHILD_CATEGORY)
      expect(sqlite.prepare('SELECT category_version FROM categories WHERE id=?').get(CHILD_CATEGORY)).toEqual({
        category_version: 2
      })
      expect(() => sqlite.prepare('UPDATE categories SET category_version=1 WHERE id=?').run(CHILD_CATEGORY)).toThrow()
      expect(() => sqlite.prepare('UPDATE categories SET category_version=4 WHERE id=?').run(CHILD_CATEGORY)).toThrow()
    }
  )
  it.each([
    { name: 'X' },
    { name: ' Nombre\n' },
    { parentId: '10' },
    { parentId: 0 },
    { parentId: undefined },
    { expectedVersion: 1 },
    { reason: 'no' },
    { status: 'published' },
    { slug: 'stolen' },
    { uuid: ROOT_CATEGORY },
    { sort: 0 },
    { source_id: null }
  ])('rejects strict create payload %# without any write', async (extra) => {
    const before = state()
    await expect(create({ ...createBody(), ...extra })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(state()).toEqual(before)
  })
  it('rejects getters, inherited/custom prototypes and coercion without calling them, but accepts null-prototype own data', async () => {
    const getter = vi.fn(() => 'Getter name'),
      coerce = vi.fn(() => 10)
    const hostile = [
      Object.defineProperty(createBody(), 'name', { enumerable: true, get: getter }),
      Object.create(createBody()),
      Object.assign(Object.create({ inherited: true }), createBody()),
      { ...createBody(), parentId: { valueOf: coerce } }
    ]
    for (const value of hostile) await expect(create(value)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(getter).not.toHaveBeenCalled()
    expect(coerce).not.toHaveBeenCalled()
    expect((await create(Object.assign(Object.create(null), createBody()))).status).toBe('draft')
  })
  it.each(['01', '0', '-1', '1.0', '9007199254740992', '11\n'])(
    'rejects noncanonical target %s',
    async (categoryId) => {
      await expect(update(categoryId)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  )
  it('requires explicit own reason and safe expectedVersion and preserves optional null/omission', () => {
    expect(createCategoryInputSchema.safeParse(createBody()).success).toBe(true)
    expect(updateCategoryInputSchema.parse(updateBody())).not.toHaveProperty('parentId')
    expect(updateCategoryInputSchema.parse(updateBody({ parentId: null })).parentId).toBeNull()
    expect(
      deleteCategoryInputSchema.safeParse({ expectedVersion: Number.MAX_SAFE_INTEGER, reason: 'Motivo válido' }).success
    ).toBe(false)
    expect(deleteCategoryInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false)
  })
  it('reader keeps cumulative counts and exposes exact unmapped parent separately from legacy projection', async () => {
    sqlite
      .prepare(
        "INSERT INTO categories(id,parent_id,name,slug,status,sort_order) VALUES ('unmapped-exact-parent',?,'X','unmapped-exact-parent','hidden',-2)"
      )
      .run(ROOT_CATEGORY)
    sqlite
      .prepare("UPDATE categories SET parent_id='unmapped-exact-parent',sort_order=-1 WHERE id=?")
      .run(CHILD_CATEGORY)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status) VALUES ('mapped-second',13,'unmapped-exact-parent','Segunda mapeada','segunda-mapeada','draft')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO products(id,category_id,name,slug,status) VALUES ('private-count',?,'Producto privado','producto-count','draft')"
      )
      .run(CHILD_CATEGORY)
    const result = await listD1AdminCategories(database, CATEGORY_CLAIMS, categoryUtc())
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('Expected confirmed private view')
    const view = parseD1CategoryAdminView(result.data)
    expect(view).not.toBeNull()
    expect(view!.capabilities).toMatchObject({ categoryCreate: true, categoryUpdate: true, categoryDelete: true })
    expect(view!.flat.find((row) => row.id === 11)).toMatchObject({
      parentId: 10,
      sort: -1,
      count: 1,
      authoring: { actualParentUuid: 'unmapped-exact-parent', actualParentId: null, parentMapped: false, sort: -1 }
    })
    expect(view!.flat.find((row) => row.id === 10)?.count).toBe(1)
    expect(view!.unmappedCategories).toBe(1)
  })
  it('catalog.write reader without administration.manage keeps its private tree but no writable capabilities', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
    const result = await listD1AdminCategories(database, CATEGORY_CLAIMS, categoryUtc())
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('Expected confirmed private view')
    expect(result.data.capabilities).toMatchObject({
      categoriesRead: true,
      categoryCreate: false,
      categoryUpdate: false,
      categoryDelete: false
    })
  })
  it('requires an own read capability even if the ambient Object prototype supplies true', async () => {
    const result = await listD1AdminCategories(database, CATEGORY_CLAIMS, categoryUtc())
    if (result.outcome !== 'found') throw new Error('Expected confirmed private view')
    Reflect.deleteProperty(result.data.capabilities, 'categoriesRead')
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'categoriesRead')
    try {
      Object.defineProperty(Object.prototype, 'categoriesRead', { value: true, configurable: true })
      expect(parseD1CategoryAdminView(result.data)).toBeNull()
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'categoriesRead', previous)
      else Reflect.deleteProperty(Object.prototype, 'categoriesRead')
    }
  })
  it('rechecks catalog.write after the awaited writer-capability query before projecting private rows', async () => {
    const native = database.prepare.bind(database)
    const wrapped = proxy({
      prepare(sql) {
        const statement = native(sql)
        let permission: unknown
        const result = new Proxy(statement, {
          get(target, key, receiver) {
            if (key === 'bind')
              return (...parameters: unknown[]) => {
                permission = parameters[1]
                statement.bind(...parameters)
                return result
              }
            if (key === 'first')
              return async <T>() => {
                const row = await statement.first<T>()
                if (permission === 'administration.manage')
                  sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
                return row
              }
            return Reflect.get(target, key, receiver)
          }
        })
        return result
      }
    })
    expect(await listD1AdminCategories(wrapped, CATEGORY_CLAIMS, categoryUtc())).toEqual({
      outcome: 'denied',
      code: 'forbidden'
    })
  })
})
