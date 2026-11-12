import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import {
  AdminCatalogStatusError,
  productStatusInputSchema,
  updateD1ProductStatus,
  type CatalogPublicationGate,
  type ProductStatusInput
} from '../../workers/catalog/admin-catalog-status'
import { ADMIN_CATALOG_STATUSES, type AdminCatalogStatus } from '../../workers/catalog/admin-catalog'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { testUuid, testNow } from '../support/deterministic'

const IDENTITY = '10000000-0000-4000-8000-000000000035'
const SESSION = '20000000-0000-4000-8000-000000000035'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const REASON = 'Synthetic local editorial state decision'
const GRAPH: Record<AdminCatalogStatus, readonly AdminCatalogStatus[]> = {
  draft: ['review', 'hidden', 'discontinued'],
  review: ['draft', 'published', 'hidden'],
  published: ['hidden', 'discontinued'],
  hidden: ['draft', 'review', 'published', 'discontinued'],
  discontinued: ['draft']
}
function utc(milliseconds = testNow()) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function inputValues(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value
    throw new Error('unexpected_test_binding')
  })
}
function excluding(row: Record<string, SQLOutputValue>, fields: string[]) {
  return Object.fromEntries(Object.entries(row).filter(([field]) => !fields.includes(field)))
}

// Actual SQLite, every migration, production SQL clock: no fake timers and no
// provider evidence. The test gate proves the hook/atomic contract only.
describe('D1 product state commands with immutable audit and authoritative gate hook', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    const past = utc(testNow() - 86400_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES (?, 'status-editor@example.invalid', 'synthetic-not-a-login-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, past, past, past)
    sqlite.exec(`INSERT INTO roles VALUES ('status_editor','Editor','Synthetic local fixture');
      INSERT OR IGNORE INTO permissions VALUES
        ('catalog.write','catalog','write','Synthetic local fixture'),
        ('catalog.publish','catalog','publish','Synthetic local fixture');
      INSERT INTO role_permissions VALUES ('status_editor','catalog.write'),('status_editor','catalog.publish');
      UPDATE products SET status='draft',brand_id='b1',published_at=NULL,
        attributes='{"unchanged":{"media":true}}',regulatory='{"requiresSds":true}' WHERE id='p-1';
      UPDATE variants SET status='draft' WHERE id='v-1-1';
      INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,updated_at)
        VALUES ('v-1-2',12,'p-1','t21','sp1','SKU-1-2','Caja','hidden',700,'2026-01-02T00:00:00Z'),
          ('v-1-3',13,'p-1','t21','sp1','SKU-1-3','Retired','discontinued',900,'2026-01-03T00:00:00Z');`)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, 'status_editor', ?)")
      .run(IDENTITY, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(SESSION, IDENTITY, past, utc(testNow() + 3600_000))
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })

  function product(id = 'p-1') {
    return sqlite.prepare('SELECT * FROM products WHERE id=?').get(id)!
  }
  function variants() {
    return sqlite.prepare("SELECT * FROM variants WHERE product_id='p-1' ORDER BY id").all()
  }
  function version() {
    return Number(product().catalog_version)
  }
  function body(status: AdminCatalogStatus = 'review'): ProductStatusInput {
    return { status, expectedVersion: version(), reason: REASON }
  }
  function counts() {
    return sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM catalog_product_status_commands) AS commands,
      (SELECT count(*) FROM catalog_product_status_audit) AS audits,
      (SELECT count(*) FROM catalog_product_status_guards) AS guards`
      )
      .get()!
  }
  function state() {
    return { product: product(), variants: variants(), counts: counts() }
  }
  function gate(): CatalogPublicationGate {
    return {
      async prepare(db, target, claims) {
        expect(target).toEqual({ productUuid: 'p-1', productId: 1 })
        expect(claims).toEqual(CLAIMS)
        const row = await db
          .prepare("SELECT price_gross_cents FROM variants WHERE id='v-1-1'")
          .first<{ price_gross_cents: number }>()
        if (!row) throw new AdminCatalogStatusError('publication_blocked')
        return {
          fingerprint: 'b'.repeat(64),
          condition(offset) {
            expect(offset).toBe(16)
            return {
              sql: `EXISTS(SELECT 1 FROM variants WHERE id=?${offset + 1} AND price_gross_cents=?${offset + 2})`,
              parameters: ['v-1-1', row.price_gross_cents]
            }
          }
        }
      }
    }
  }
  function mutate(
    input: unknown = body(),
    options: {
      database?: D1Database
      key?: string
      id?: string
      claims?: typeof CLAIMS | null
      gate?: CatalogPublicationGate
    } = {}
  ) {
    return updateD1ProductStatus(
      options.database ?? database,
      options.claims === undefined ? CLAIMS : options.claims,
      options.id ?? '1',
      input,
      { idempotencyKey: options.key ?? testUuid(), publicationGate: options.gate }
    )
  }
  function databaseWith(overrides: Partial<Pick<D1Database, 'prepare' | 'batch'>>): D1Database {
    // D1Database is a platform class. Spreading it erases prototype methods in
    // its actual type/runtime contract; proxy only the deliberate test hooks.
    return new Proxy(database, {
      get(target, property) {
        if (property === 'prepare' && overrides.prepare) return overrides.prepare
        if (property === 'batch' && overrides.batch) return overrides.batch
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  function beforeBatch(action: () => void): D1Database {
    const batch = database.batch.bind(database)
    return databaseWith({
      async batch<T>(statements: D1PreparedStatement[]) {
        action()
        return batch<T>(statements)
      }
    })
  }
  function serializedBatches(): D1Database {
    const batch = database.batch.bind(database)
    let preceding = Promise.resolve()
    return databaseWith({
      async batch<T>(statements: D1PreparedStatement[]) {
        const waiting = preceding
        let release!: () => void
        preceding = new Promise<void>((resolve) => {
          release = resolve
        })
        await waiting
        try {
          return await batch<T>(statements)
        } finally {
          release()
        }
      }
    })
  }
  function onlyPermission(permission: 'catalog.write' | 'catalog.publish') {
    sqlite.prepare('DELETE FROM role_permissions WHERE permission_code<>?').run(permission)
  }
  function setStatus(status: AdminCatalogStatus) {
    sqlite.prepare("UPDATE products SET status=? WHERE id='p-1'").run(status)
  }

  it.each(ADMIN_CATALOG_STATUSES.flatMap((from) => ADMIN_CATALOG_STATUSES.map((to) => [from, to] as const)))(
    'enforces the exact Node graph %s -> %s',
    async (from, to) => {
      setStatus(from)
      const previous = state()
      const payload = body(to)
      if (!GRAPH[from].includes(to)) {
        await expect(mutate(payload, { gate: gate() })).rejects.toMatchObject({ code: 'invalid_transition' })
        expect(state()).toEqual(previous)
        return
      }
      const result = await mutate(payload, { gate: gate() })
      expect(result).toEqual({
        source: 'cloudflare',
        productId: 1,
        productUuid: 'p-1',
        catalogVersion: payload.expectedVersion + 1,
        status: to,
        active: to === 'published',
        updated: true
      })
      expect(product()).toMatchObject({ status: to, catalog_version: payload.expectedVersion + 1 })
      expect(variants().map((row) => row.status)).toEqual([to, to, 'discontinued'])
      expect(variants()[2]).toEqual(previous.variants[2])
      expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    }
  )

  it.each(['draft', 'review'] as const)('allows catalog.write only for the editorial %s edge', async (from) => {
    setStatus(from)
    onlyPermission('catalog.write')
    const to = from === 'draft' ? 'review' : 'draft'
    await expect(mutate(body(to))).resolves.toMatchObject({ status: to })
    expect(sqlite.prepare('SELECT required_permission FROM catalog_product_status_commands').get()).toEqual({
      required_permission: 'catalog.write'
    })
  })
  it.each([
    ['draft', 'hidden'],
    ['draft', 'discontinued'],
    ['review', 'hidden'],
    ['review', 'published'],
    ['published', 'hidden'],
    ['published', 'discontinued'],
    ['hidden', 'draft'],
    ['hidden', 'review'],
    ['hidden', 'published'],
    ['hidden', 'discontinued'],
    ['discontinued', 'draft']
  ] satisfies [AdminCatalogStatus, AdminCatalogStatus][])(
    'requires publish, not write, for %s -> %s',
    async (from, to) => {
      setStatus(from)
      onlyPermission('catalog.write')
      const previous = state()
      await expect(mutate(body(to), { gate: gate() })).rejects.toMatchObject({ code: 'forbidden' })
      expect(state()).toEqual(previous)
      sqlite.exec(
        "DELETE FROM role_permissions; INSERT INTO role_permissions VALUES ('status_editor','catalog.publish')"
      )
      await expect(mutate(body(to), { gate: gate() })).resolves.toMatchObject({ status: to })
      expect(sqlite.prepare('SELECT required_permission FROM catalog_product_status_commands').get()).toEqual({
        required_permission: 'catalog.publish'
      })
    }
  )
  it('does not grant draft/review editorial permission to a publisher-only actor', async () => {
    onlyPermission('catalog.publish')
    await expect(mutate()).rejects.toMatchObject({ code: 'forbidden' })
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })

  it('preserves every non-state catalog/variant field and stores ordered before/after variant snapshots', async () => {
    const before = state()
    const payload = body()
    const result = await mutate(payload, { key: 'preserved-state' })
    expect(excluding(product(), ['status', 'catalog_version', 'updated_at', 'published_at'])).toEqual(
      excluding(before.product, ['status', 'catalog_version', 'updated_at', 'published_at'])
    )
    expect(variants().map((row) => excluding(row, ['status', 'updated_at']))).toEqual(
      before.variants.map((row) => excluding(row, ['status', 'updated_at']))
    )
    const audit = sqlite.prepare('SELECT * FROM catalog_product_status_audit').get()!
    const command = sqlite.prepare('SELECT * FROM catalog_product_status_commands').get()!
    expect(JSON.parse(String(audit.before_variants))).toEqual(
      before.variants.map((row) => ({
        uuid: row.id,
        legacyId: row.legacy_id,
        status: row.status,
        updatedAt: row.updated_at
      }))
    )
    expect(JSON.parse(String(audit.after_variants))).toEqual(
      variants().map((row) => ({
        uuid: row.id,
        legacyId: row.legacy_id,
        status: row.status,
        updatedAt: row.updated_at
      }))
    )
    expect(audit.before_version).toBe(payload.expectedVersion)
    expect(audit.after_version).toBe(payload.expectedVersion + 1)
    expect(command.response).toBe(JSON.stringify(result))
    expect(command.gate_fingerprint).toBeNull()
    expect(product().published_at).toBeNull()
  })
  it('does not resurrect discontinued variants when reopening a discontinued product', async () => {
    setStatus('discontinued')
    sqlite.exec("UPDATE variants SET status='discontinued' WHERE product_id='p-1'")
    const previous = variants()
    await mutate(body('draft'))
    expect(variants()).toEqual(previous)
    expect(product().status).toBe('draft')
  })
  it('does not call publication prepare on non-publication transitions', async () => {
    const hook = gate()
    const prepare = vi.spyOn(hook, 'prepare')
    await mutate(body(), { gate: hook })
    expect(prepare).not.toHaveBeenCalled()
  })
  it('requires publication gate and audits its fingerprint when publishing', async () => {
    setStatus('review')
    const previous = state()
    await expect(mutate(body('published'))).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(state()).toEqual(previous)
    await mutate(body('published'), { gate: gate() })
    expect(sqlite.prepare('SELECT gate_fingerprint FROM catalog_product_status_audit').get()).toEqual({
      gate_fingerprint: 'b'.repeat(64)
    })
    expect(product().published_at).toBe(product().updated_at)
    const firstPublished = product().published_at
    await mutate(body('hidden'))
    await mutate(body('published'), { gate: gate() })
    expect(product().published_at).toBe(firstPublished)
  })
  it('preserves authoritative gate publication issues without writes', async () => {
    setStatus('review')
    const issues = [{ path: 'publication.policy', code: 'policy.pending', message: 'Falta revisión autorizada' }]
    const hook: CatalogPublicationGate = {
      async prepare() {
        throw new AdminCatalogStatusError('publication_blocked', issues)
      }
    }
    await expect(mutate(body('published'), { gate: hook })).rejects.toMatchObject({
      code: 'publication_blocked',
      issues
    })
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })

  it.each([
    undefined,
    null,
    [],
    true,
    'published',
    {},
    { status: 'review' },
    { status: 'review', expectedVersion: 1 },
    { expectedVersion: 1, reason: REASON },
    { status: 'active', expectedVersion: 1, reason: REASON },
    { status: 'review', expectedVersion: '1', reason: REASON },
    { status: 'review', expectedVersion: 0, reason: REASON },
    { status: 'review', expectedVersion: 1.5, reason: REASON },
    { status: 'review', expectedVersion: Number.MAX_SAFE_INTEGER, reason: REASON },
    { status: 'review', expectedVersion: 1, reason: 'ab' },
    { status: 'review', expectedVersion: 1, reason: 'r'.repeat(501) },
    { status: 'review', expectedVersion: 1, reason: '\nvalid reason\n' },
    { status: 'review', expectedVersion: 1, reason: '\tvalid reason' },
    { status: 'review', expectedVersion: 1, reason: 'valid\u007freason' },
    { status: 'review', expectedVersion: 1, reason: REASON, name: 'Not metadata' },
    { status: 'review', expectedVersion: 1, reason: REASON, unknown: undefined }
  ])('rejects strict malformed body %# without D1', async (input) => {
    expect(productStatusInputSchema.safeParse(input).success).toBe(false)
    const prepare = vi.spyOn(database, 'prepare')
    await expect(
      updateD1ProductStatus(database, CLAIMS, '1', input, { idempotencyKey: 'malformed' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(prepare).not.toHaveBeenCalled()
  })
  it('does not evaluate getters, prototypes, symbol keys or scalar coercions', async () => {
    let getterCalls = 0
    const accessor = { ...body() }
    Object.defineProperty(accessor, 'status', {
      enumerable: true,
      get() {
        getterCalls++
        return 'review'
      }
    })
    const inherited = Object.create(body())
    const symbol = { ...body(), [Symbol('secret')]: 'not data' }
    const nonenumerable = { ...body() }
    Object.defineProperty(nonenumerable, 'reason', { enumerable: false, value: REASON })
    const coercion = {
      ...body(),
      expectedVersion: {
        valueOf() {
          throw new Error('do not coerce')
        }
      }
    }
    for (const value of [accessor, inherited, symbol, nonenumerable, coercion]) {
      expect(productStatusInputSchema.safeParse(value).success).toBe(false)
      await expect(mutate(value)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(getterCalls).toBe(0)
  })
  it('accepts plain null-prototype own data and trims ordinary spaces without mutating the caller', async () => {
    const payload = Object.assign(Object.create(null), body(), { reason: '  Synthetic reason  ' })
    const original = Object.getOwnPropertyDescriptors(payload)
    await mutate(payload)
    expect(Object.getOwnPropertyDescriptors(payload)).toEqual(original)
    expect(sqlite.prepare('SELECT reason FROM catalog_product_status_commands').get()).toEqual({
      reason: 'Synthetic reason'
    })
  })
  it.each(['0', '-1', '01', '+1', '1.0', ' 1', '1 ', '1\n', '1\t', '9007199254740992'])(
    'rejects noncanonical legacy id %j',
    async (id) => {
      await expect(mutate(body(), { id })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    }
  )
  it.each(['', ' x', 'x ', 'x\n', 'x\t', 'x\u007f', 'x'.repeat(201), 'x/y'])(
    'rejects noncanonical idempotency key %j',
    async (key) => {
      await expect(mutate(body(), { key })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    }
  )
  it('reports not found for an authorized canonical id and version conflict for a stale command', async () => {
    await expect(mutate(body(), { id: '999' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(mutate({ ...body(), expectedVersion: version() - 1 })).rejects.toMatchObject({
      code: 'version_conflict'
    })
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })
  it('rejects inherited/accessor/symbol/non-data options without executing accessors', async () => {
    let calls = 0
    const accessor = { idempotencyKey: 'option-test' }
    Object.defineProperty(accessor, 'idempotencyKey', {
      enumerable: true,
      get() {
        calls++
        return 'option-test'
      }
    })
    const inherited = { idempotencyKey: 'option-test' }
    Object.setPrototypeOf(inherited, { now: utc() })
    const symbol = { idempotencyKey: 'option-test', [Symbol('not option')]: true }
    const unknown = { idempotencyKey: 'option-test', unsupported: undefined }
    const nonenumerable = { idempotencyKey: 'option-test' }
    Object.defineProperty(nonenumerable, 'idempotencyKey', { value: 'option-test', enumerable: false })
    for (const options of [accessor, inherited, symbol, unknown, nonenumerable]) {
      await expect(updateD1ProductStatus(database, CLAIMS, '1', body(), options)).rejects.toMatchObject({
        code: 'invalid_input'
      })
    }
    expect(calls).toBe(0)
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })
  it.each([123, {}, true, null, '2026-01-01T00:00:00.000Z', '2026-02-30T00:00:00Z', '2026-01-01T00:00:00Z\n'])(
    'rejects an invalid internal test clock %# rather than coercing it',
    async (now) => {
      const options = { idempotencyKey: 'invalid-clock' }
      Object.defineProperty(options, 'now', { enumerable: true, value: now })
      await expect(updateD1ProductStatus(database, CLAIMS, '1', body(), options)).rejects.toMatchObject({
        code: 'invalid_input'
      })
      expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    }
  )
  it.each(['fingerprint', 'sql', 'parameters'] as const)(
    'fails closed on a malformed trusted gate result: %s',
    async (field) => {
      setStatus('review')
      const hook: CatalogPublicationGate = {
        async prepare() {
          const prepared = {
            fingerprint: 'b'.repeat(64),
            condition() {
              const condition = { sql: '1', parameters: [] }
              if (field === 'sql') Object.defineProperty(condition, 'sql', { value: '' })
              if (field === 'parameters') Object.defineProperty(condition, 'parameters', { value: [undefined] })
              return condition
            }
          }
          if (field === 'fingerprint') Object.defineProperty(prepared, 'fingerprint', { value: 'invalid-hash' })
          return prepared
        }
      }
      const previous = state()
      await expect(mutate(body('published'), { gate: hook })).rejects.toMatchObject({ code: 'publication_blocked' })
      expect(state()).toEqual(previous)
    }
  )

  const REVOKES = [
    ['DELETE FROM role_permissions', 'forbidden'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["UPDATE identities SET status='disabled'", 'unauthenticated'],
    ["UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'unauthenticated'],
    ["UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'forbidden']
  ] as const
  it.each(REVOKES)('checks current authority before any new command: %s', async (sql, code) => {
    sqlite.exec(sql)
    await expect(mutate()).rejects.toMatchObject({ code })
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })
  it.each(REVOKES)('SQL clock/grants/email/MFA block late authority loss: %s', async (sql, code) => {
    const previous = state()
    await expect(mutate(body(), { database: beforeBatch(() => sqlite.exec(sql)) })).rejects.toMatchObject({ code })
    expect(state()).toEqual(previous)
  })
  it('requires server-verified claims and never activates a supplied claims getter', async () => {
    await expect(mutate(body(), { claims: null })).rejects.toMatchObject({ code: 'unauthenticated' })
    let calls = 0
    const claims = { ...CLAIMS }
    Object.defineProperty(claims, 'sessionId', {
      enumerable: true,
      get() {
        calls++
        return SESSION
      }
    })
    await expect(mutate(body(), { claims })).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(calls).toBe(0)
  })
  it('uses null production clock and no changes() dependency in every mutation batch statement', async () => {
    const batch = database.batch.bind(database)
    const captured: { sql: string; parameters: unknown[] }[] = []
    const inspected = databaseWith({
      prepare(sql) {
        const statement = database.prepare(sql),
          bind = statement.bind.bind(statement)
        statement.bind = (...parameters) => {
          if (sql.includes('catalog_product_status_')) captured.push({ sql, parameters })
          return bind(...parameters)
        }
        return statement
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        expect(statements).toHaveLength(6)
        return batch<T>(statements)
      }
    })
    await mutate(body(), { database: inspected })
    expect(captured.length).toBeGreaterThanOrEqual(7)
    for (const statement of captured) {
      expect(statement.parameters[0]).toBeNull()
      expect(statement.sql).not.toMatch(/changes\s*\(/i)
    }
  })

  it.each([
    ['claim', 'catalog_product_status_commands'],
    ['audit', 'catalog_product_status_audit']
  ] as const)('rolls back the whole command when authority changes inside %s', async (_stage, table) => {
    const previous = state()
    sqlite.exec(`CREATE TRIGGER fixture_status_revoke AFTER INSERT ON ${table}
        BEGIN UPDATE auth_sessions SET mfa_verified=0 WHERE id='${SESSION}'; END;`)
    await expect(mutate()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(previous)
    expect(sqlite.prepare('SELECT mfa_verified FROM auth_sessions').get()).toEqual({ mfa_verified: 1 })
  })
  it('rolls back product, every variant, claim and audit on forced audit ABORT', async () => {
    const previous = state()
    sqlite.exec(`CREATE TRIGGER fixture_status_audit_abort BEFORE INSERT ON catalog_product_status_audit
      BEGIN SELECT RAISE(ABORT,'fixture_forced_status_audit_abort'); END;`)
    await expect(mutate()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(previous)
  })
  it('rolls back if a claimed live variant is discontinued before CAS instead of resurrecting it', async () => {
    const previous = state()
    sqlite.exec(`CREATE TRIGGER fixture_variant_retired AFTER INSERT ON catalog_product_status_commands
      BEGIN UPDATE variants SET status='discontinued' WHERE id='v-1-2'; END;`)
    await expect(mutate()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(previous)
  })
  it('rolls back if an extra variant appears between product CAS and variant propagation', async () => {
    const previous = state()
    sqlite.exec(`CREATE TRIGGER fixture_variant_added AFTER UPDATE OF status ON products WHEN NEW.id='p-1'
      BEGIN INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
        VALUES ('v-1-4',14,'p-1','t21','sp1','SKU-1-4','Unexpected','hidden',700); END;`)
    await expect(mutate()).rejects.toMatchObject({ code: 'conflict' })
    expect(state()).toEqual(previous)
  })
  it('does not overwrite an external product change between preflight and CAS', async () => {
    let changed: ReturnType<typeof state> | undefined
    await expect(
      mutate(body(), {
        database: beforeBatch(() => {
          sqlite.exec("UPDATE products SET name='Concurrent writer' WHERE id='p-1'")
          changed = state()
        })
      })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(state()).toEqual(changed)
  })
  it('captures current variant states when a dependency changes before the claim without product version bump', async () => {
    const previousVersion = version()
    await mutate(body(), {
      database: beforeBatch(() => sqlite.exec("UPDATE variants SET status='discontinued' WHERE id='v-1-2'"))
    })
    expect(version()).toBe(previousVersion + 1)
    expect(variants().map((row) => row.status)).toEqual(['review', 'discontinued', 'discontinued'])
    const audit = sqlite.prepare('SELECT before_variants FROM catalog_product_status_audit').get()!
    expect(JSON.parse(String(audit.before_variants))[1].status).toBe('discontinued')
  })
  it('does not authorize publication after a late gate dependency change without a product version bump', async () => {
    setStatus('review')
    const previous = state()
    await expect(
      mutate(body('published'), {
        gate: gate(),
        database: beforeBatch(() => {
          sqlite.exec("UPDATE variants SET price_gross_cents=999 WHERE id='v-1-1'")
        })
      })
    ).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(product()).toEqual(previous.product)
    expect(version()).toBe(Number(previous.product.catalog_version))
    const firstVariant = variants()[0]
    if (!firstVariant) throw new Error('Missing synthetic variant fixture')
    expect(firstVariant.price_gross_cents).toBe(999)
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })
  it.each([
    ['AFTER INSERT ON catalog_product_status_commands', 'claim'],
    ["AFTER UPDATE OF status ON products WHEN NEW.id='p-1'", 'CAS'],
    ['AFTER INSERT ON catalog_product_status_audit', 'final guard']
  ])('reevaluates authoritative dependencies after %s (%s) and rolls back', async (trigger, _stage) => {
    setStatus('review')
    const previous = state()
    sqlite.exec(`CREATE TRIGGER fixture_gate_dependency ${trigger}
      BEGIN UPDATE variants SET price_gross_cents=999 WHERE id='v-1-1'; END;`)
    await expect(mutate(body('published'), { gate: gate() })).rejects.toMatchObject({ code: 'publication_blocked' })
    expect(state()).toEqual(previous)
  })

  it('replays exact historical JSON before current state/version checks and never calls a current gate', async () => {
    setStatus('review')
    const payload = body('published')
    const result = await mutate(payload, { key: 'historical-publication', gate: gate() })
    const persisted = sqlite
      .prepare("SELECT response FROM catalog_product_status_commands WHERE idempotency_key='historical-publication'")
      .get()!
    await mutate(body('hidden'))
    sqlite.exec("UPDATE variants SET price_gross_cents=987 WHERE id='v-1-1'")
    const hook = gate(),
      prepare = vi.spyOn(hook, 'prepare')
    const replayed = await mutate(payload, { key: 'historical-publication', gate: hook })
    expect(replayed).toEqual(result)
    expect(JSON.stringify(replayed)).toBe(persisted.response)
    expect(replayed.active).toBe(true)
    expect(product().status).toBe('hidden')
    expect(prepare).not.toHaveBeenCalled()
    expect(counts()).toEqual({ commands: 2, audits: 2, guards: 0 })
  })
  it.each(['catalog.write', 'catalog.publish'] as const)(
    'requires original persisted %s permission for replay, not current graph',
    async (original) => {
      const payload = body(original === 'catalog.write' ? 'review' : 'hidden')
      await mutate(payload, { key: 'original-permission' })
      sqlite.prepare('DELETE FROM role_permissions WHERE permission_code=?').run(original)
      await expect(mutate(payload, { key: 'original-permission' })).rejects.toMatchObject({ code: 'forbidden' })
      expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    }
  )
  it.each(REVOKES)('requires fresh authority even for exact replay: %s', async (sql, code) => {
    const payload = body()
    await mutate(payload, { key: 'fresh-replay-auth' })
    const previous = state()
    sqlite.exec(sql)
    await expect(mutate(payload, { key: 'fresh-replay-auth' })).rejects.toMatchObject({ code })
    expect(state()).toEqual(previous)
  })
  it('rejects key reuse with any different route or canonical business field', async () => {
    const payload = body()
    await mutate(payload, { key: 'one-command' })
    for (const patch of [
      { status: 'hidden' },
      { expectedVersion: payload.expectedVersion + 1 },
      { reason: 'Other reason' }
    ]) {
      await expect(mutate({ ...payload, ...patch }, { key: 'one-command' })).rejects.toMatchObject({
        code: 'idempotency_conflict'
      })
    }
    await expect(mutate(payload, { key: 'one-command', id: '2' })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
  it('commits one same-key identical race and returns byte-identical receipts', async () => {
    const payload = body(),
      db = serializedBatches()
    const results = await Promise.all([
      mutate(payload, { database: db, key: 'same-race' }),
      mutate({ ...payload }, { database: db, key: 'same-race' })
    ])
    expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[1]))
    expect(version()).toBe(payload.expectedVersion + 1)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
  it('an ambiguous post-commit outage returns no invented success and recovers only by exact live-authorized replay', async () => {
    const batch = database.batch.bind(database)
    const outage = databaseWith({
      async batch<T>(statements: D1PreparedStatement[]) {
        await batch<T>(statements)
        throw new Error('synthetic_storage_unavailable')
      }
    })
    const payload = body()
    await expect(mutate(payload, { database: outage, key: 'ambiguous-commit' })).rejects.toThrow(
      'synthetic_storage_unavailable'
    )
    expect(version()).toBe(payload.expectedVersion + 1)
    const response = sqlite
      .prepare("SELECT response FROM catalog_product_status_commands WHERE idempotency_key='ambiguous-commit'")
      .get()!.response
    expect(JSON.stringify(await mutate(payload, { key: 'ambiguous-commit' }))).toBe(response)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
  it.each([true, false])('commits only one version race, same key=%s', async (sameKey) => {
    const payload = body(),
      db = serializedBatches()
    const results = await Promise.allSettled([
      mutate(payload, { database: db, key: 'race-a' }),
      mutate({ ...payload, status: 'hidden' }, { database: db, key: sameKey ? 'race-a' : 'race-b' })
    ])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: {
        code: sameKey ? 'idempotency_conflict' : 'version_conflict'
      }
    })
    expect(version()).toBe(payload.expectedVersion + 1)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })
  it('cannot steal another claim nonce or treat its unaudited receipt as completion', async () => {
    const previous = state()
    let captured: { sql: string; parameters: SQLInputValue[] } | undefined
    let foreign: Record<string, SQLOutputValue> | undefined
    const batch = database.batch.bind(database)
    const raced = databaseWith({
      prepare(sql) {
        const statement = database.prepare(sql),
          bind = statement.bind.bind(statement)
        statement.bind = (...parameters) => {
          if (sql.includes('INSERT INTO catalog_product_status_commands'))
            captured = { sql, parameters: inputValues(parameters) }
          return bind(...parameters)
        }
        return statement
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        expect(captured).toBeDefined()
        const parameters = [...captured!.parameters]
        parameters[12] = testUuid()
        sqlite.prepare(captured!.sql).run(...parameters)
        foreign = sqlite.prepare('SELECT * FROM catalog_product_status_commands').get()
        return batch<T>(statements)
      }
    })
    await expect(mutate(body(), { database: raced, key: 'foreign-claim' })).rejects.toMatchObject({ code: 'conflict' })
    expect(product()).toEqual(previous.product)
    expect(variants()).toEqual(previous.variants)
    expect(sqlite.prepare('SELECT * FROM catalog_product_status_commands').get()).toEqual(foreign)
    expect(counts()).toEqual({ commands: 1, audits: 0, guards: 0 })
  })
  it.each([0, 1])('increments exactly once and preserves FTS under recursive_triggers=%i', async (recursive) => {
    sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
    const expected = version()
    await mutate(body())
    expect(version()).toBe(expected + 1)
    await mutate(body('draft'))
    expect(version()).toBe(expected + 2)
    sqlite.exec("INSERT INTO products_fts(products_fts,rank) VALUES ('integrity-check',1)")
    sqlite.exec("UPDATE products SET updated_at='2026-01-01T00:00:00Z' WHERE id='p-1'")
    expect(version()).toBe(expected + 2)
  })
  it.each([0, 1])('keeps commands/audit append-only against UPDATE/DELETE/REPLACE, recursion=%i', async (recursive) => {
    sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
    await mutate(body(), { key: 'immutable' })
    for (const table of ['catalog_product_status_commands', 'catalog_product_status_audit']) {
      const row = sqlite.prepare(`SELECT * FROM ${table}`).get()!
      const recordId = row.id
      if (typeof recordId !== 'string') throw new Error('Missing synthetic audit fixture identity')
      expect(() => sqlite.prepare(`UPDATE ${table} SET reason='Changed audit' WHERE id=?`).run(recordId)).toThrow()
      expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(recordId)).toThrow()
      const fields = Object.keys(row),
        values = Object.values(row)
      const replace = sqlite.prepare(
        `INSERT OR REPLACE INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
      )
      expect(() => replace.run(...values)).toThrow()
      values[fields.indexOf('id')] = testUuid()
      expect(() => replace.run(...values)).toThrow()
      expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([row])
    }
  })
  it.each([0, 1])(
    'allows the last safe version then blocks any further transition, recursion=%i',
    async (recursive) => {
      sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
      const guard = String(
        sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='products_catalog_version_insert'").get()!.sql
      )
      // Isolated ceiling fixture, restored before executing the service. Normal
      // inserts are forbidden from manufacturing an editorial version.
      sqlite.exec('DROP TRIGGER products_catalog_version_insert')
      sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,name,slug,status,catalog_version)
      VALUES ('ceiling-product',999,'c1','Ceiling fixture','ceiling-fixture','draft',?)`
        )
        .run(Number.MAX_SAFE_INTEGER - 1)
      sqlite.exec(guard)
      const receipt = await mutate(
        { status: 'review', expectedVersion: Number.MAX_SAFE_INTEGER - 1, reason: REASON },
        { id: '999' }
      )
      expect(receipt.catalogVersion).toBe(Number.MAX_SAFE_INTEGER)
      expect(JSON.stringify(receipt)).toBe(
        sqlite.prepare("SELECT response FROM catalog_product_status_commands WHERE product_id='ceiling-product'").get()!
          .response
      )
      await expect(
        mutate({ status: 'draft', expectedVersion: Number.MAX_SAFE_INTEGER, reason: REASON }, { id: '999' })
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(product('ceiling-product').catalog_version).toBe(Number.MAX_SAFE_INTEGER)
      expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    }
  )
})
