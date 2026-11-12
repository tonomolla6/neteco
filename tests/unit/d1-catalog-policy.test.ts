import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  CatalogPolicyError,
  executeD1CatalogPolicyCommand,
  readD1CatalogPolicies,
  readD1ProductPublicationPolicy
} from '../../workers/catalog/catalog-policy'
import {
  policyCreateInputSchema,
  policyAssignInputSchema,
  exceptionCreateInputSchema,
  policyWithdrawInputSchema,
  exceptionWithdrawInputSchema,
  type CatalogPolicyAction,
  type CatalogPolicyReceipt,
  type PolicyCreateInput
} from '../../shared/catalog-publication-policy'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { testUuid, testNow } from '../support/deterministic'

const IDENTITY = '10000000-0000-4000-8000-000000000037'
const SESSION = '20000000-0000-4000-8000-000000000037'
const PRODUCT = '81000000-0000-4000-8000-000000000037'
const VARIANT = '82000000-0000-4000-8000-000000000037'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const REASON = 'Synthetic local governance test decision'
const utc = (milliseconds = testNow()) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')

// The fixtures are synthetic governance records in an ephemeral SQLite database,
// not approval of actual products, rights, regulatory policy or provider evidence.
describe('governed D1 publication policy authoring and private reads', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    sqlite.function('synthetic_catalog_policy_clock', () => {
      const clock = vi.getMockedSystemTime()
      if (!clock) throw new Error('missing_synthetic_catalog_policy_clock')
      return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
    })
    const nativeDatabase = d1OverSqlite(sqlite),
      nativePrepare = nativeDatabase.prepare.bind(nativeDatabase)
    database = new Proxy(nativeDatabase, {})
    database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_catalog_policy_clock()'))
    const past = utc(testNow() - 86400_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?,'policy-author@example.invalid','synthetic-not-login-hash',?,'active',?,?)`
      )
      .run(IDENTITY, past, past, past)
    sqlite.exec(`INSERT INTO roles VALUES ('policy_author','Policy author','Synthetic local fixture');
      INSERT OR IGNORE INTO permissions VALUES ('catalog.publish','catalog','publish','Synthetic fixture');
      INSERT INTO role_permissions VALUES ('policy_author','catalog.publish');`)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'policy_author',?)")
      .run(IDENTITY, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?,?,1,1,?,?)`
      )
      .run(SESSION, IDENTITY, past, utc(testNow() + 3600_000))
    sqlite
      .prepare(
        `INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes,regulatory)
      VALUES (?,101,'c1','b1','Governance fixture','governance-fixture','draft',
      '{"media":{"preserved":true}}','{"unknown":{"nested":[1,null,true]},"manufacturer":"Existing manufacturer"}')`
      )
      .run(PRODUCT)
    sqlite
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
      price_gross_cents,mpn,backorder_allowed,lead_time_days)
      VALUES (?,1001,?,'t21','sp1','GOV-FIXTURE','Unit','draft',500,'GOV-MPN',1,5)`
      )
      .run(VARIANT, PRODUCT)
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  function product() {
    return sqlite.prepare('SELECT * FROM products WHERE id=?').get(PRODUCT)!
  }
  function version() {
    return Number(product().catalog_version)
  }
  function policyInput(overrides: Partial<PolicyCreateInput> = {}): PolicyCreateInput {
    return {
      code: 'local_fixture',
      name: 'Synthetic local policy',
      expectedVersion: 0,
      requiredFields: ['regulatory.requiresSds'],
      requiredMediaRoles: ['datasheet'],
      identifierExceptionsAllowed: true,
      validFrom: utc(testNow() - 3600_000),
      validUntil: null,
      reason: REASON,
      ...overrides
    }
  }
  function execute(
    action: CatalogPolicyAction,
    target: { productId?: string; resourceId?: string },
    body: unknown,
    options: { key?: string; database?: D1Database; claims?: typeof CLAIMS | null; now?: string } = {}
  ) {
    return executeD1CatalogPolicyCommand(
      options.database ?? database,
      options.claims === undefined ? CLAIMS : options.claims,
      action,
      target,
      body,
      { idempotencyKey: options.key ?? testUuid(), ...(options.now === undefined ? {} : { now: options.now }) }
    )
  }
  function create(overrides: Partial<PolicyCreateInput> = {}, options: { key?: string; database?: D1Database } = {}) {
    return execute('policy_create', {}, policyInput(overrides), options)
  }
  function assign(policyId: string, options: { key?: string; database?: D1Database } = {}) {
    return execute(
      'policy_assign',
      { productId: '101' },
      {
        expectedVersion: version(),
        policyId,
        regulatory: { productType: 'local_fixture', requiresSds: false },
        reason: REASON
      },
      options
    )
  }
  function exceptionInput(overrides: Record<string, unknown> = {}) {
    return {
      expectedVersion: version(),
      variantId: VARIANT,
      reason: REASON,
      evidenceReference: 'Synthetic fixture reference',
      validFrom: utc(testNow() - 3600_000),
      validUntil: null,
      ...overrides
    }
  }
  function counts() {
    return sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM catalog_policy_commands) commands,
      (SELECT count(*) FROM catalog_policy_audit) audits, (SELECT count(*) FROM catalog_policy_guards) guards,
      (SELECT count(*) FROM catalog_publication_policies) policies,
      (SELECT count(*) FROM catalog_publication_policy_withdrawals) policyWithdrawals,
      (SELECT count(*) FROM catalog_product_publication_policies) assignments,
      (SELECT count(*) FROM catalog_variant_identifier_exceptions) exceptions,
      (SELECT count(*) FROM catalog_variant_identifier_exception_withdrawals) exceptionWithdrawals`
      )
      .get()!
  }
  function snapshot() {
    return {
      product: product(),
      variants: sqlite.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(PRODUCT),
      counts: counts(),
      assignments: sqlite.prepare('SELECT * FROM catalog_product_publication_policies ORDER BY seq').all()
    }
  }
  function proxy(overrides: Partial<Pick<D1Database, 'prepare' | 'batch'>>): D1Database {
    return new Proxy(database, {
      get(target, key) {
        if (key === 'prepare' && overrides.prepare) return overrides.prepare
        if (key === 'batch' && overrides.batch) return overrides.batch
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  function beforeBatch(action: () => void) {
    return proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        action()
        return database.batch<T>(statements)
      }
    })
  }
  function serialized() {
    let preceding = Promise.resolve()
    return proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const waiting = preceding
        let release!: () => void
        preceding = new Promise<void>((resolve) => {
          release = resolve
        })
        await waiting
        try {
          return await database.batch<T>(statements)
        } finally {
          release()
        }
      }
    })
  }
  function persisted(receipt: CatalogPolicyReceipt) {
    const command = sqlite.prepare('SELECT * FROM catalog_policy_commands WHERE entity_id=?').get(receipt.entityId)!
    expect(JSON.stringify(receipt)).toBe(command.response)
    expect(
      sqlite.prepare('SELECT response FROM catalog_policy_audit WHERE command_id=?').get(command.id)?.response
    ).toBe(command.response)
    expect(Object.keys(receipt)).toEqual([
      'source',
      'action',
      'entityId',
      'resourceId',
      'policyVersion',
      'productId',
      'productUuid',
      'catalogVersion',
      'updated'
    ])
    return command
  }
  function afterFirst(predicate: (sql: string) => boolean, action: () => void) {
    return proxy({
      prepare(sql) {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property) {
              if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
              if (property === 'first')
                return async <T>(column?: string): Promise<T | null> => {
                  const result = column === undefined ? await target.first<T>() : await target.first<T>(column)
                  if (predicate(sql)) action()
                  return result
                }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        return wrap(database.prepare(sql))
      }
    })
  }
  async function setupAssigned(options: Partial<PolicyCreateInput> = {}) {
    const policy = await create(options)
    await assign(policy.entityId)
    return policy
  }
  async function withdrawPolicy(policy: CatalogPolicyReceipt, options: { database?: D1Database; key?: string } = {}) {
    return execute(
      'policy_withdraw',
      { resourceId: policy.resourceId },
      { expectedVersion: policy.policyVersion, reason: REASON },
      options
    )
  }

  it('creates version one with exact array/text snapshots and persisted receipt key order', async () => {
    const receipt = await create()
    expect(receipt).toEqual({
      source: 'cloudflare',
      action: 'policy_create',
      entityId: receipt.entityId,
      resourceId: receipt.entityId,
      policyVersion: 1,
      productId: null,
      productUuid: null,
      catalogVersion: null,
      updated: true
    })
    const command = persisted(receipt)
    const state = JSON.parse(String(command.after_state))
    expect(state.entity.required_fields).toBe('["regulatory.requiresSds"]')
    expect(state.entity.required_media_roles).toBe('["datasheet"]')
    expect(counts()).toMatchObject({ commands: 1, audits: 1, guards: 0, policies: 1 })
  })

  it('completes all five actions, preserves omitted regulatory extras and never mutates price/stock/media/status', async () => {
    const before = snapshot()
    const policy = await create()
    const assigned = await assign(policy.entityId)
    expect(assigned).toMatchObject({
      action: 'policy_assign',
      resourceId: policy.entityId,
      policyVersion: 1,
      productId: 101,
      productUuid: PRODUCT,
      catalogVersion: Number(before.product.catalog_version) + 1
    })
    expect(JSON.parse(String(product().regulatory))).toEqual({
      unknown: { nested: [1, null, true] },
      manufacturer: 'Existing manufacturer',
      productType: 'local_fixture',
      requiresSds: false
    })
    const exception = await execute('exception_create', { productId: '101' }, exceptionInput())
    expect(exception).toMatchObject({
      action: 'exception_create',
      resourceId: VARIANT,
      policyVersion: 1,
      catalogVersion: assigned.catalogVersion! + 1
    })
    await withdrawPolicy(policy)
    const withdrawn = await execute(
      'exception_withdraw',
      { productId: '101', resourceId: exception.entityId },
      { expectedVersion: version(), reason: REASON }
    )
    expect(withdrawn).toMatchObject({
      policyVersion: null,
      resourceId: exception.entityId,
      catalogVersion: exception.catalogVersion! + 1
    })
    for (const receipt of [policy, assigned, exception, withdrawn]) persisted(receipt)
    expect(snapshot().variants).toEqual(before.variants)
    const changed = new Set(['regulatory', 'catalog_version', 'updated_at'])
    expect(Object.fromEntries(Object.entries(product()).filter(([key]) => !changed.has(key)))).toEqual(
      Object.fromEntries(Object.entries(before.product).filter(([key]) => !changed.has(key)))
    )
    expect(counts()).toMatchObject({
      commands: 5,
      audits: 5,
      guards: 0,
      policies: 1,
      assignments: 1,
      exceptions: 1,
      policyWithdrawals: 1,
      exceptionWithdrawals: 1
    })
  })

  it('allows optional metadata clearing but absence conserves every known and unknown existing key', async () => {
    const policy = await create()
    await execute(
      'policy_assign',
      { productId: '101' },
      {
        expectedVersion: version(),
        policyId: policy.entityId,
        regulatory: {
          productType: 'local_fixture',
          requiresSds: true,
          safetyInstructions: 'Line one\nLine two\tOK',
          manufacturer: 'New manufacturer',
          hazardStatements: ''
        },
        reason: REASON
      }
    )
    await assign(policy.entityId)
    expect(JSON.parse(String(product().regulatory))).toEqual({
      unknown: { nested: [1, null, true] },
      productType: 'local_fixture',
      requiresSds: false,
      safetyInstructions: 'Line one\nLine two\tOK',
      manufacturer: 'New manufacturer',
      hazardStatements: ''
    })
    expect(counts().assignments).toBe(2)
  })

  it('retains withdrawn versions in MAX(code) and allows explicitly future policies without making them current', async () => {
    const first = await create()
    await withdrawPolicy(first)
    await expect(create()).rejects.toMatchObject({ code: 'version_conflict' })
    const second = await create({ expectedVersion: 1, validFrom: utc(testNow() + 86400_000) })
    expect(second.policyVersion).toBe(2)
    await expect(assign(second.entityId)).rejects.toMatchObject({ code: 'policy_unavailable' })
    const view = await readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 1, code: 'local_fixture' })
    expect(view.items[0]).toMatchObject({ id: second.entityId, version: 2, current: false, withdrawn: false })
    expect(view.pagination).toEqual({ page: 1, perPage: 1, total: 2, pages: 2 })
  })

  it.each(['draft', 'review', 'hidden'] as const)(
    'permits product governance in %s without changing its status',
    async (status) => {
      sqlite.prepare('UPDATE products SET status=? WHERE id=?').run(status, PRODUCT)
      const policy = await setupAssigned()
      const exception = await execute('exception_create', { productId: '101' }, exceptionInput())
      await execute(
        'exception_withdraw',
        { productId: '101', resourceId: exception.entityId },
        { expectedVersion: version(), reason: REASON }
      )
      expect(product().status).toBe(status)
      await withdrawPolicy(policy)
    }
  )
  it.each(['published', 'discontinued'] as const)('rejects all new product governance in %s', async (status) => {
    const policy = await setupAssigned()
    const exception = await execute('exception_create', { productId: '101' }, exceptionInput())
    sqlite.prepare('UPDATE products SET status=? WHERE id=?').run(status, PRODUCT)
    const before = snapshot()
    await expect(assign(policy.entityId)).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(execute('exception_create', { productId: '101' }, exceptionInput())).rejects.toMatchObject({
      code: 'invalid_state'
    })
    await expect(
      execute(
        'exception_withdraw',
        { productId: '101', resourceId: exception.entityId },
        { expectedVersion: version(), reason: REASON }
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(snapshot()).toEqual(before)
  })

  it.each(['null', '[]', '"scalar"', '42'])('never silently replaces unsafe regulatory JSON %s', async (regulatory) => {
    const policy = await create()
    sqlite.prepare('UPDATE products SET regulatory=? WHERE id=?').run(regulatory, PRODUCT)
    const before = snapshot()
    await expect(assign(policy.entityId)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(snapshot()).toEqual(before)
  })
  it('requires exact policy classification and an explicit boolean before exception approval', async () => {
    const policy = await create()
    await expect(
      execute(
        'policy_assign',
        { productId: '101' },
        {
          expectedVersion: version(),
          policyId: policy.entityId,
          regulatory: { productType: 'other_type', requiresSds: false },
          reason: REASON
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await assign(policy.entityId)
    sqlite.prepare('UPDATE products SET regulatory=? WHERE id=?').run('{"productType":"local_fixture"}', PRODUCT)
    await expect(execute('exception_create', { productId: '101' }, exceptionInput())).rejects.toMatchObject({
      code: 'policy_unavailable'
    })
  })
  it('refuses absent, withdrawn, expired or exception-denying current policy', async () => {
    await expect(execute('exception_create', { productId: '101' }, exceptionInput())).rejects.toMatchObject({
      code: 'policy_unavailable'
    })
    const policy = await setupAssigned({ identifierExceptionsAllowed: false })
    await expect(execute('exception_create', { productId: '101' }, exceptionInput())).rejects.toMatchObject({
      code: 'policy_unavailable'
    })
    await withdrawPolicy(policy)
    await expect(assign(policy.entityId)).rejects.toMatchObject({ code: 'policy_unavailable' })
    const expired = await create({
      code: 'expired_fixture',
      validFrom: utc(testNow() - 7200_000),
      validUntil: utc(testNow() - 3600_000)
    })
    await expect(
      execute(
        'policy_assign',
        { productId: '101' },
        {
          expectedVersion: version(),
          policyId: expired.entityId,
          regulatory: { productType: 'expired_fixture', requiresSds: false },
          reason: REASON
        }
      )
    ).rejects.toMatchObject({ code: 'policy_unavailable' })
  })
  it('rejects foreign/discontinued variants and foreign/missing exception withdrawals', async () => {
    await setupAssigned()
    const other = testUuid()
    sqlite
      .prepare(
        `INSERT INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      VALUES (?,'p-2','t21','sp1','OTHER-GOV','Unit','draft',500)`
      )
      .run(other)
    await expect(
      execute('exception_create', { productId: '101' }, exceptionInput({ variantId: other }))
    ).rejects.toMatchObject({ code: 'not_found' })
    sqlite.prepare("UPDATE variants SET status='discontinued' WHERE id=?").run(VARIANT)
    await expect(execute('exception_create', { productId: '101' }, exceptionInput())).rejects.toMatchObject({
      code: 'invalid_state'
    })
    await expect(
      execute(
        'exception_withdraw',
        { productId: '101', resourceId: testUuid() },
        { expectedVersion: version(), reason: REASON }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('refuses duplicate withdrawals but permits exact historical replay', async () => {
    const policy = await setupAssigned()
    const exception = await execute('exception_create', { productId: '101' }, exceptionInput())
    await withdrawPolicy(policy)
    await expect(withdrawPolicy(policy)).rejects.toMatchObject({ code: 'invalid_state' })
    await execute(
      'exception_withdraw',
      { productId: '101', resourceId: exception.entityId },
      { expectedVersion: version(), reason: REASON }
    )
    await expect(
      execute(
        'exception_withdraw',
        { productId: '101', resourceId: exception.entityId },
        { expectedVersion: version(), reason: REASON }
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
  it('blocks withdrawal only when the latest assignment of a published product uses that policy', async () => {
    const first = await setupAssigned()
    sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(PRODUCT)
    await expect(withdrawPolicy(first)).rejects.toMatchObject({ code: 'policy_in_use' })
    sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(PRODUCT)
    const second = await create({ expectedVersion: 1 })
    await assign(second.entityId)
    sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(PRODUCT)
    await withdrawPolicy(first)
    await expect(withdrawPolicy(second)).rejects.toMatchObject({ code: 'policy_in_use' })
    const list = await readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 50 })
    expect(list.items.map((item) => [item.version, item.assignedProductCount, item.publishedProductCount])).toEqual([
      [2, 1, 1],
      [1, 0, 0]
    ])
  })

  const authCases = [
    ['revoked session', "UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'unauthenticated'],
    [
      'expired session',
      "UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      'unauthenticated'
    ],
    ['identity version', 'UPDATE identities SET session_version=session_version+1', 'unauthenticated'],
    ['email verification', 'UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['MFA', 'UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['publisher grant', 'DELETE FROM role_permissions', 'forbidden'],
    [
      'expired grant',
      "UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      'forbidden'
    ]
  ] as const
  it.each(authCases)('requires fresh %s for every private read and command', async (_label, sql, code) => {
    sqlite.exec(sql.replaceAll("'now'", 'synthetic_catalog_policy_clock()'))
    await expect(create()).rejects.toMatchObject({ code })
    await expect(readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 10 })).rejects.toMatchObject({ code })
    await expect(readD1ProductPublicationPolicy(database, CLAIMS, '101')).rejects.toMatchObject({ code })
    expect(counts().commands).toBe(0)
  })
  it.each(authCases)('rolls back late %s before the command batch', async (_label, sql, code) => {
    const before = snapshot()
    await expect(
      create(
        {},
        { database: beforeBatch(() => sqlite.exec(sql.replaceAll("'now'", 'synthetic_catalog_policy_clock()'))) }
      )
    ).rejects.toMatchObject({ code })
    expect(snapshot()).toEqual(before)
  })
  it('catalog.write alone is insufficient for all new governance reads and writes', async () => {
    sqlite.exec(
      "DELETE FROM role_permissions; INSERT OR IGNORE INTO permissions VALUES ('catalog.write','catalog','write','Synthetic'); INSERT INTO role_permissions VALUES ('policy_author','catalog.write')"
    )
    await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
    await expect(readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 1 })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(readD1ProductPublicationPolicy(database, CLAIMS, '101')).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('rejects missing claims without querying D1', async () => {
    const prepare = vi.fn(database.prepare.bind(database)),
      db = proxy({ prepare })
    await expect(execute('policy_create', {}, policyInput(), { database: db, claims: null })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['claim', 'assignment', 'audit'] as const)(
    'live SQL revocation at %s aborts every write and the revocation itself',
    async (stage) => {
      const policy = await create()
      const table =
        stage === 'claim'
          ? 'catalog_policy_commands'
          : stage === 'assignment'
            ? 'catalog_product_publication_policies'
            : 'catalog_policy_audit'
      sqlite.exec(`CREATE TRIGGER revoke_inside_batch AFTER INSERT ON ${table} BEGIN DELETE FROM role_permissions; END`)
      const before = snapshot()
      await expect(assign(policy.entityId)).rejects.toMatchObject({ code: 'conflict' })
      expect(snapshot()).toEqual(before)
      expect(sqlite.prepare('SELECT count(*) count FROM role_permissions').get()?.count).toBe(1)
    }
  )
  it('withdrawal postguard detects a trigger publishing a dependent product and rolls it all back', async () => {
    const policy = await setupAssigned()
    sqlite.exec(`CREATE TRIGGER publish_after_withdraw AFTER INSERT ON catalog_publication_policy_withdrawals
      BEGIN UPDATE products SET status='published' WHERE id='${PRODUCT}'; END`)
    const before = snapshot()
    await expect(withdrawPolicy(policy)).rejects.toMatchObject({ code: 'conflict' })
    expect(snapshot()).toEqual(before)
  })
  it.each(['regulatory', 'assignment'] as const)('rejects trigger mutation of %s after owned CAS', async (kind) => {
    const policy = await setupAssigned()
    const next = await create({ expectedVersion: 1 })
    const change =
      kind === 'regulatory'
        ? `UPDATE products SET regulatory='{"productType":"unexpected","requiresSds":true}' WHERE id='${PRODUCT}';`
        : `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
         VALUES ('${testUuid()}','${PRODUCT}','${policy.entityId}','${IDENTITY}','${REASON}',strftime('%Y-%m-%dT%H:%M:%SZ','now'));`
    sqlite.exec(`CREATE TRIGGER mutate_after_cas AFTER UPDATE OF catalog_version ON products
      WHEN NEW.id='${PRODUCT}' AND NEW.catalog_version=OLD.catalog_version+1 BEGIN ${change} END`)
    const before = snapshot()
    await expect(assign(next.entityId)).rejects.toMatchObject({ code: 'conflict' })
    expect(snapshot()).toEqual(before)
  })
  it.each(['ignore', 'abort'] as const)('missing audit proof (%s) rolls back claim and domain writes', async (mode) => {
    sqlite.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON catalog_policy_audit BEGIN SELECT RAISE(${mode === 'ignore' ? 'IGNORE' : "ABORT,'SQLITE_CONSTRAINT: synthetic audit failure'"}); END`
    )
    const before = snapshot()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(snapshot()).toEqual(before)
  })
  it('late policy withdrawal before assignment makes no product or command changes', async () => {
    const policy = await create()
    const db = beforeBatch(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
      VALUES (?,?,?,?,?)`
        )
        .run(testUuid(), policy.entityId, IDENTITY, REASON, utc())
    )
    const previous = product()
    await expect(assign(policy.entityId, { database: db })).rejects.toMatchObject({ code: 'policy_unavailable' })
    expect(product()).toEqual(previous)
    expect(counts()).toMatchObject({ commands: 1, audits: 1, assignments: 0 })
  })
  it('late discontinued variant cannot receive an identifier exception', async () => {
    await setupAssigned()
    const db = beforeBatch(() => sqlite.prepare("UPDATE variants SET status='discontinued' WHERE id=?").run(VARIANT))
    const previous = product()
    await expect(
      execute('exception_create', { productId: '101' }, exceptionInput(), { database: db })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(product()).toEqual(previous)
    expect(counts().exceptions).toBe(0)
  })
  it('unrelated assignment sequence changes before batch do not create a false conflict', async () => {
    const policy = await create()
    const db = beforeBatch(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
      VALUES (?,'p-2',?,?,?,?)`
        )
        .run(testUuid(), policy.entityId, IDENTITY, REASON, utc())
    )
    await assign(policy.entityId, { database: db })
    expect(counts().assignments).toBe(2)
  })

  it('same-code version races have exactly one winner and no orphan claims', async () => {
    const db = serialized(),
      body = policyInput()
    const results = await Promise.allSettled([
      execute('policy_create', {}, body, { database: db }),
      execute('policy_create', {}, body, { database: db })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((result) => result.status === 'rejected')
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ code: 'version_conflict' })
    expect(counts()).toMatchObject({ commands: 1, audits: 1, policies: 1, guards: 0 })
  })
  it('same-key races recover exact winner receipts rather than rerunning version checks', async () => {
    const db = serialized(),
      body = policyInput(),
      key = 'race-same-key'
    const receipts = await Promise.all([
      execute('policy_create', {}, body, { database: db, key }),
      execute('policy_create', {}, body, { database: db, key })
    ])
    expect(JSON.stringify(receipts[0])).toBe(JSON.stringify(receipts[1]))
    expect(counts()).toMatchObject({ commands: 1, audits: 1, policies: 1 })
  })
  it('same-product CAS races permit one assignment and retain no losing ledger', async () => {
    const policy = await create(),
      db = serialized(),
      body = {
        expectedVersion: version(),
        policyId: policy.entityId,
        regulatory: { productType: 'local_fixture', requiresSds: false },
        reason: REASON
      }
    const results = await Promise.allSettled([
      execute('policy_assign', { productId: '101' }, body, { database: db }),
      execute('policy_assign', { productId: '101' }, body, { database: db })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((result) => result.status === 'rejected')
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ code: 'version_conflict' })
    expect(counts()).toMatchObject({ commands: 2, audits: 2, assignments: 1 })
  })
  it('replays original JSON after policy withdrawal and later version/status changes with no effects', async () => {
    const policy = await create(),
      key = 'historical-assignment',
      body = {
        expectedVersion: version(),
        policyId: policy.entityId,
        regulatory: { productType: 'local_fixture', requiresSds: false },
        reason: REASON
      }
    const receipt = await execute('policy_assign', { productId: '101' }, body, { key })
    await withdrawPolicy(policy)
    sqlite.prepare("UPDATE products SET name='Later product name',status='published' WHERE id=?").run(PRODUCT)
    const before = snapshot()
    expect(JSON.stringify(await execute('policy_assign', { productId: '101' }, body, { key }))).toBe(
      JSON.stringify(receipt)
    )
    expect(snapshot()).toEqual(before)
    sqlite.exec('DELETE FROM role_permissions')
    await expect(execute('policy_assign', { productId: '101' }, body, { key })).rejects.toMatchObject({
      code: 'forbidden'
    })
  })
  it('set arrays hash canonically while unknown values or changed payload/action/target conflict', async () => {
    const key = 'canonical-set',
      body = policyInput({ requiredFields: ['usage', 'series'], requiredMediaRoles: ['sds', 'label'] })
    const receipt = await execute('policy_create', {}, body, { key })
    expect(
      await execute(
        'policy_create',
        {},
        { ...body, requiredFields: ['series', 'usage'], requiredMediaRoles: ['label', 'sds'] },
        { key }
      )
    ).toEqual(receipt)
    await expect(execute('policy_create', {}, { ...body, name: 'Changed policy name' }, { key })).rejects.toMatchObject(
      { code: 'idempotency_conflict' }
    )
    await expect(
      execute('policy_withdraw', { resourceId: receipt.entityId }, { expectedVersion: 1, reason: REASON }, { key })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('rechecks live authorization after an awaited replay query', async () => {
    const key = 'late-replay-revoke',
      body = policyInput()
    await execute('policy_create', {}, body, { key })
    const db = afterFirst(
      (sql) => sql.includes('AS completed'),
      () => sqlite.exec('DELETE FROM role_permissions')
    )
    await expect(execute('policy_create', {}, body, { key, database: db })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('projects missing classification as null, not implicit approval, without private actor columns', async () => {
    const view = await readD1ProductPublicationPolicy(database, CLAIMS, '101')
    expect(view.regulatory).toEqual({
      productType: null,
      requiresSds: null,
      safetyInstructions: null,
      hazardStatements: null,
      precautionaryStatements: null,
      manufacturer: 'Existing manufacturer'
    })
    expect(view.policy).toBeNull()
    expect(view.variants).toEqual([
      { id: VARIANT, legacyId: 1001, status: 'draft', ean: null, gtin: null, mpn: 'GOV-MPN', identifierException: null }
    ])
    expect(JSON.stringify(view)).not.toContain(IDENTITY)
  })
  it('projects latest current nonwithdrawn exceptions and preserves older history', async () => {
    const policy = await setupAssigned()
    const first = await execute(
      'exception_create',
      { productId: '101' },
      exceptionInput({ validFrom: utc(testNow() - 7200_000) })
    )
    const second = await execute(
      'exception_create',
      { productId: '101' },
      exceptionInput({ validFrom: utc(testNow() - 3600_000) })
    )
    const future = await execute(
      'exception_create',
      { productId: '101' },
      exceptionInput({ validFrom: utc(testNow() + 3600_000) })
    )
    expect((await readD1ProductPublicationPolicy(database, CLAIMS, '101')).variants[0]?.identifierException?.id).toBe(
      second.entityId
    )
    await execute(
      'exception_withdraw',
      { productId: '101', resourceId: second.entityId },
      { expectedVersion: version(), reason: REASON }
    )
    expect((await readD1ProductPublicationPolicy(database, CLAIMS, '101')).variants[0]?.identifierException?.id).toBe(
      first.entityId
    )
    await withdrawPolicy(policy)
    expect((await readD1ProductPublicationPolicy(database, CLAIMS, '101')).policy).toMatchObject({
      current: false,
      withdrawn: true
    })
    expect(counts().exceptions).toBe(3)
    expect(future.entityId).not.toBe(second.entityId)
  })
  it('sorts codes ascending and versions descending with stable filtering/pagination', async () => {
    await create({ code: 'z_type' })
    await create({ code: 'a_type' })
    await create({ code: 'a_type', expectedVersion: 1 })
    const view = await readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 50 })
    expect(view.items.map((item) => [item.code, item.version])).toEqual([
      ['a_type', 2],
      ['a_type', 1],
      ['z_type', 1]
    ])
    expect(
      (await readD1CatalogPolicies(database, CLAIMS, { page: 2, perPage: 1, code: 'a_type' })).items[0]?.version
    ).toBe(1)
    expect((await readD1CatalogPolicies(database, CLAIMS, { page: 10, perPage: 50 })).pagination).toEqual({
      page: 10,
      perPage: 50,
      total: 3,
      pages: 1
    })
  })
  it.each(['list', 'product'] as const)('rechecks late grant revocation before returning a %s DTO', async (reader) => {
    const db = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const results = await database.batch<T>(statements)
        sqlite.exec('DELETE FROM role_permissions')
        return results
      }
    })
    await expect(
      reader === 'list'
        ? readD1CatalogPolicies(db, CLAIMS, { page: 1, perPage: 50 })
        : readD1ProductPublicationPolicy(db, CLAIMS, '101')
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it.each(['list', 'product', 'write'] as const)(
    'rejects missing success metadata from %s batches as unavailable, never empty success',
    async (operation) => {
      const db = proxy({
        async batch<T>(statements: D1PreparedStatement[]) {
          const results = await database.batch<T>(statements)
          Reflect.deleteProperty(results[0]!, 'success')
          return results
        }
      })
      const promise =
        operation === 'list'
          ? readD1CatalogPolicies(db, CLAIMS, { page: 1, perPage: 50 })
          : operation === 'product'
            ? readD1ProductPublicationPolicy(db, CLAIMS, '101')
            : create({}, { database: db })
      await expect(promise).rejects.toThrow(`catalog_policy_${operation === 'write' ? 'write' : 'read'}_unavailable`)
    }
  )
  it('does not classify provider errors mentioning command tables as business conflicts', async () => {
    const failure = new Error('catalog_policy_commands backend unavailable')
    const db = proxy({
      async batch() {
        throw failure
      }
    })
    await expect(create({}, { database: db })).rejects.toBe(failure)
  })
  it.each(['null', '[]', '{"requiresSds":null}', '{"requiresSds":"false"}', '{"manufacturer":12}'])(
    'malformed known regulatory source %s is never a valid DTO',
    async (regulatory) => {
      sqlite.prepare('UPDATE products SET regulatory=? WHERE id=?').run(regulatory, PRODUCT)
      await expect(readD1ProductPublicationPolicy(database, CLAIMS, '101')).rejects.not.toBeInstanceOf(
        CatalogPolicyError
      )
    }
  )
  it('reports not_found rather than empty product DTO', async () => {
    await expect(readD1ProductPublicationPolicy(database, CLAIMS, '999')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('rejects over 500 variants rather than silently truncating private governance', async () => {
    const insert =
      sqlite.prepare(`INSERT INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      VALUES (?,?,'t21','sp1',?,'Unit','draft',500)`)
    for (let index = 0; index < 500; index++) insert.run(testUuid(), PRODUCT, `VAR-OVERFLOW-${index}`)
    await expect(readD1ProductPublicationPolicy(database, CLAIMS, '101')).rejects.toMatchObject({ code: 'conflict' })
  })

  it.each([0, 1])(
    'commands, matching audit and governance records are immutable with recursive_triggers=%s',
    async (recursive) => {
      sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
      const policy = await create(),
        receipt = await assign(policy.entityId)
      persisted(receipt)
      for (const table of [
        'catalog_policy_commands',
        'catalog_policy_audit',
        'catalog_publication_policies',
        'catalog_product_publication_policies'
      ]) {
        const before = sqlite.prepare(`SELECT * FROM ${table}`).all()
        const columns = Object.keys(before[0]!).join(',')
        expect(() => sqlite.exec(`UPDATE ${table} SET reason=reason`)).toThrow(/immutable/)
        expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
        expect(() =>
          sqlite.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`)
        ).toThrow(/immutable/)
        expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(before)
      }
    }
  )
  it('cannot add mismatching audit evidence to an existing immutable command', async () => {
    const receipt = await create(),
      command = persisted(receipt)
    const columns = Object.keys(sqlite.prepare('SELECT * FROM catalog_policy_audit LIMIT 1').get()!).filter(
      (key) => key !== 'id' && key !== 'command_id'
    )
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_policy_audit(id,command_id,${columns.join(',')})
      SELECT ?,?,${columns.map((key) => (key === 'reason' ? "'Corrupted audit reason'" : `c.${key}`)).join(',')}
      FROM catalog_policy_commands c WHERE c.id=?`
        )
        .run(testUuid(), command.id, command.id)
    ).toThrow(/immutable|audit_command/)
  })
  it('an unaudited foreign claim never completes or authorizes a stolen nonce write', async () => {
    let intercepted = false
    const db = proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const claim = statements[0]!
        const sql: unknown = Reflect.get(claim, 'sql')
        if (!intercepted && typeof sql === 'string' && sql.includes('INSERT INTO catalog_policy_commands')) {
          intercepted = true
          // Publish a foreign claim with the exact business input but another nonce;
          // this partial row has no audit or domain effect and must not be replayed.
          await claim.all()
          sqlite.exec('DROP TRIGGER catalog_policy_commands_no_update')
          sqlite.prepare('UPDATE catalog_policy_commands SET claim_nonce=?').run(testUuid())
          sqlite.exec(
            "CREATE TRIGGER catalog_policy_commands_no_update BEFORE UPDATE ON catalog_policy_commands BEGIN SELECT RAISE(ABORT,'catalog_policy_commands_immutable'); END"
          )
        }
        return database.batch<T>(statements)
      }
    })
    await expect(create({}, { database: db })).rejects.toMatchObject({ code: 'conflict' })
    expect(counts()).toMatchObject({ commands: 1, audits: 0, policies: 0, guards: 0 })
  })

  it('corrupted audit insertion cannot substitute for exact command evidence and rolls back everything', async () => {
    const columns = [
      'id',
      'command_id',
      'actor_id',
      'action',
      'target',
      'input',
      'entity_id',
      'resource_id',
      'policy_version',
      'product_id',
      'product_uuid',
      'expected_version',
      'result_version',
      'reason',
      'before_state',
      'after_state',
      'response',
      'created_at'
    ]
    sqlite.exec(`CREATE TRIGGER corrupt_audit BEFORE INSERT ON catalog_policy_audit BEGIN
      INSERT INTO catalog_policy_audit(${columns.join(',')}) VALUES (${columns
        .map((column) => (column === 'reason' ? "'Corrupted governance reason'" : `NEW.${column}`))
        .join(',')}); END`)
    const before = snapshot()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(snapshot()).toEqual(before)
  })
  it('late external assignment change without a product version bump invalidates the owned command', async () => {
    const first = await setupAssigned(),
      second = await create({ expectedVersion: 1 })
    const db = beforeBatch(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
      VALUES (?,?,?,?,?,?)`
        )
        .run(testUuid(), PRODUCT, first.entityId, IDENTITY, REASON, utc())
    )
    const previous = product()
    await expect(assign(second.entityId, { database: db })).rejects.toMatchObject({ code: 'conflict' })
    expect(product()).toEqual(previous)
    expect(counts()).toMatchObject({ commands: 3, audits: 3, assignments: 2 })
  })
  it('a dependency becoming published before withdrawal returns policy_in_use with no partial effects', async () => {
    const policy = await setupAssigned()
    const db = beforeBatch(() => sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(PRODUCT))
    await expect(withdrawPolicy(policy, { database: db })).rejects.toMatchObject({ code: 'policy_in_use' })
    expect(counts()).toMatchObject({ commands: 2, audits: 2, policyWithdrawals: 0, guards: 0 })
  })
  it('same-key different-payload races fail as idempotency_conflict, not a stale version write', async () => {
    const db = serialized(),
      body = policyInput(),
      key = 'raced-different-payload'
    const results = await Promise.allSettled([
      execute('policy_create', {}, body, { database: db, key }),
      execute('policy_create', {}, { ...body, name: 'Other reviewed policy' }, { database: db, key })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((result) => result.status === 'rejected')
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ code: 'idempotency_conflict' })
    expect(counts()).toMatchObject({ commands: 1, audits: 1, policies: 1 })
  })
  it('payload hashing distinguishes omitted regulatory fields from explicit clearing and target identity', async () => {
    const policy = await create(),
      body = {
        expectedVersion: version(),
        policyId: policy.entityId,
        regulatory: { productType: 'local_fixture', requiresSds: false },
        reason: REASON
      },
      key = 'presence-sensitive'
    await execute('policy_assign', { productId: '101' }, body, { key })
    await expect(
      execute(
        'policy_assign',
        { productId: '101' },
        { ...body, regulatory: { ...body.regulatory, safetyInstructions: '' } },
        { key }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(execute('policy_assign', { productId: '102' }, body, { key })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('the same idempotency key is actor scoped rather than globally blocking another publisher', async () => {
    const key = 'actor-isolated-key',
      first = await create({}, { key }),
      otherIdentity = testUuid(),
      otherSession = testUuid(),
      past = utc(testNow() - 86400_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?,'other-author@example.invalid','synthetic-hash',?,'active',?,?)`
      )
      .run(otherIdentity, past, past, past)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'policy_author',?)")
      .run(otherIdentity, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(otherSession, otherIdentity, past, utc(testNow() + 3600_000))
    const second = await execute('policy_create', {}, policyInput({ expectedVersion: 1 }), {
      key,
      claims: { identityId: otherIdentity, sessionId: otherSession, sessionVersion: 1 }
    })
    expect(second.entityId).not.toBe(first.entityId)
    expect(second.policyVersion).toBe(2)
  })
  it.each(['101\n', '01', '0', '-1', '1.0', '1e2', ' 101', '9007199254740992'])(
    'rejects noncanonical product target %s without D1 work',
    async (id) => {
      const prepare = vi.fn(database.prepare.bind(database)),
        db = proxy({ prepare })
      await expect(
        execute(
          'policy_assign',
          { productId: id },
          {
            expectedVersion: 1,
            policyId: VARIANT,
            regulatory: { productType: 'local_fixture', requiresSds: false },
            reason: REASON
          },
          { database: db }
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(prepare).not.toHaveBeenCalled()
      await expect(readD1ProductPublicationPolicy(db, CLAIMS, id)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  )
  it.each(['key\n', 'key\t', ' key', 'key ', '', 'x'.repeat(201)])(
    'rejects noncanonical idempotency key without querying D1: %s',
    async (key) => {
      const prepare = vi.fn(database.prepare.bind(database)),
        db = proxy({ prepare })
      await expect(create({}, { key, database: db })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(prepare).not.toHaveBeenCalled()
    }
  )
  it.each([
    { page: 0, perPage: 10 },
    { page: 1000001, perPage: 10 },
    { page: 1, perPage: 0 },
    { page: 1, perPage: 51 },
    { page: 1, perPage: 10, code: 'bad_type\n' },
    { page: 1, perPage: 10, code: undefined }
  ])('rejects strict list query %j', async (query) => {
    await expect(readD1CatalogPolicies(database, CLAIMS, query)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('production SQL binds NULL instead of capturing JS time and does not depend on changes()', async () => {
    const sqlStatements: string[] = [],
      bound: unknown[][] = []
    const db = proxy({
      prepare(sql) {
        sqlStatements.push(sql)
        const statement = database.prepare(sql)
        return new Proxy(statement, {
          get(target, key) {
            if (key === 'bind')
              return (...parameters: unknown[]) => {
                bound.push(parameters)
                return target.bind(...parameters)
              }
            const value: unknown = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    })
    await create({}, { database: db })
    expect(sqlStatements.some((sql) => /changes\s*\(/i.test(sql))).toBe(false)
    const actorBindings = bound.filter((parameters) => parameters[1] === SESSION)
    expect(actorBindings.length).toBeGreaterThan(4)
    expect(actorBindings.every((parameters) => parameters[0] === null)).toBe(true)
  })
  it('trusted test clock is canonical and not an arbitrary date/coercion boundary', async () => {
    await expect(
      execute('policy_create', {}, policyInput(), { now: '2026-09-01T00:00:00.000Z' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      readD1CatalogPolicies(database, CLAIMS, { page: 1, perPage: 1 }, '2026-02-30T00:00:00Z')
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it.each(['list', 'product'] as const)(
    'post-%s authorization uses the fresh real clock across a fractional second, not a truncated baseline',
    async (reader) => {
      const beginning = Math.ceil(testNow() / 1000) * 1000 + 900
      sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(beginning + 100), SESSION)
      // Only this boundary probe controls Date. SQLite migrations, transactions and
      // ordinary command fixtures continue to use the real production SQL clock.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(beginning)
      const db = proxy({
        async batch<T>(statements: D1PreparedStatement[]) {
          const results = await database.batch<T>(statements)
          vi.setSystemTime(beginning + 200)
          return results
        }
      })
      await expect(
        reader === 'list'
          ? readD1CatalogPolicies(db, CLAIMS, { page: 1, perPage: 50 })
          : readD1ProductPublicationPolicy(db, CLAIMS, '101')
      ).rejects.toMatchObject({ code: 'unauthenticated' })
    }
  )
  it.each(['list', 'product'] as const)(
    'post-%s checks a publisher grant expiring across the fractional second',
    async (reader) => {
      const beginning = Math.ceil(testNow() / 1000) * 1000 + 900
      sqlite.prepare('UPDATE identity_roles SET expires_at=? WHERE identity_id=?').run(utc(beginning + 100), IDENTITY)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(beginning)
      const db = proxy({
        async batch<T>(statements: D1PreparedStatement[]) {
          const results = await database.batch<T>(statements)
          vi.setSystemTime(beginning + 200)
          return results
        }
      })
      await expect(
        reader === 'list'
          ? readD1CatalogPolicies(db, CLAIMS, { page: 1, perPage: 50 })
          : readD1ProductPublicationPolicy(db, CLAIMS, '101')
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  )
  it('policy withdrawal stores its newly created withdrawal UUID rather than mislabeling policy identity', async () => {
    const policy = await create(),
      withdrawal = await withdrawPolicy(policy)
    expect(withdrawal.entityId).not.toBe(policy.entityId)
    expect(withdrawal.resourceId).toBe(policy.entityId)
    persisted(withdrawal)
    expect(
      sqlite.prepare('SELECT id FROM catalog_publication_policy_withdrawals WHERE policy_id=?').get(policy.entityId)?.id
    ).toBe(withdrawal.entityId)
  })
})

describe('publication governance schemas: canonical, own-data and bounded', () => {
  const input = () => ({
    code: 'local_fixture',
    name: 'Local policy',
    expectedVersion: 0,
    requiredFields: [],
    requiredMediaRoles: [],
    identifierExceptionsAllowed: false,
    validFrom: '2026-09-01T00:00:00Z',
    validUntil: null,
    reason: REASON
  })
  it.each([
    ['unknown key', { extra: true }],
    ['code terminal LF', { code: 'local_fixture\n' }],
    ['code whitespace', { code: ' local_fixture' }],
    ['uppercase code', { code: 'Local_fixture' }],
    ['code length', { code: 'a'.repeat(65) }],
    ['code number', { code: 5 }],
    ['name short', { name: 'ab' }],
    ['name long', { name: 'a'.repeat(161) }],
    ['name raw leading tab', { name: '\tLocal policy' }],
    ['name raw trailing LF', { name: 'Local policy\n' }],
    ['reason short', { reason: 'Too short' }],
    ['reason long', { reason: 'x'.repeat(501) }],
    ['reason C0', { reason: '\n' + REASON }],
    ['reason DEL', { reason: REASON + '\x7f' }],
    ['negative version', { expectedVersion: -1 }],
    ['fractional version', { expectedVersion: 1.5 }],
    ['unsafe version', { expectedVersion: Number.MAX_SAFE_INTEGER }],
    ['missing explicit bool', { identifierExceptionsAllowed: undefined }],
    ['coerced bool', { identifierExceptionsAllowed: 0 }],
    ['duplicate fields', { requiredFields: ['usage', 'usage'] }],
    ['unknown field', { requiredFields: ['price'] }],
    ['duplicate roles', { requiredMediaRoles: ['sds', 'sds'] }],
    ['unknown role', { requiredMediaRoles: ['main'] }],
    ['instant milliseconds', { validFrom: '2026-09-01T00:00:00.000Z' }],
    ['invalid calendar', { validFrom: '2026-02-30T00:00:00Z' }],
    ['instant terminal LF', { validFrom: '2026-09-01T00:00:00Z\n' }],
    ['window reversed', { validUntil: '2026-08-01T00:00:00Z' }],
    ['window equal', { validUntil: '2026-09-01T00:00:00Z' }],
    ['window missing', { validUntil: undefined }]
  ])('rejects %s', (_label, patch) => {
    expect(policyCreateInputSchema.safeParse({ ...input(), ...patch }).success).toBe(false)
  })
  it('accepts trimmed ordinary spaces after raw-control rejection without mutating caller data', () => {
    const body = { ...input(), name: ' Local policy ', reason: ' ' + REASON + ' ', requiredFields: ['usage', 'series'] }
    const before = JSON.stringify(body)
    expect(policyCreateInputSchema.parse(body)).toMatchObject({
      name: 'Local policy',
      reason: REASON,
      requiredFields: ['series', 'usage']
    })
    expect(JSON.stringify(body)).toBe(before)
  })
  it('does not execute accessors, coercion hooks, inherited fields or hostile nested objects', () => {
    const getter = vi.fn(() => 'value'),
      coercion = vi.fn(() => 'local_fixture')
    const inherited = Object.create(input())
    const accessor = { ...input() }
    Object.defineProperty(accessor, 'reason', { enumerable: true, get: getter })
    const sparse = { ...input(), requiredFields: Array(1) }
    const symbol = { ...input(), [Symbol('unexpected')]: true }
    const nonenumerable = { ...input() }
    Object.defineProperty(nonenumerable, 'extra', { value: true })
    const prototype = { ...input(), requiredFields: Object.assign(['usage'], { extra: true }) }
    for (const body of [
      inherited,
      accessor,
      sparse,
      symbol,
      nonenumerable,
      prototype,
      { ...input(), code: { toString: coercion, toJSON: coercion } },
      JSON.parse(JSON.stringify(input()).replace('"code":', '"__proto__":{},"code":'))
    ]) {
      expect(policyCreateInputSchema.safeParse(body).success).toBe(false)
    }
    expect(getter).not.toHaveBeenCalled()
    expect(coercion).not.toHaveBeenCalled()
    expect(policyCreateInputSchema.safeParse(Object.assign(Object.create(null), input())).success).toBe(true)
  })
  it('strict assignment rejects missing requiresSds, unknown nested fields, own undefined and UUID terminal LF', () => {
    const body = {
      expectedVersion: 1,
      policyId: VARIANT,
      regulatory: { productType: 'local_fixture', requiresSds: false },
      reason: REASON
    }
    for (const patch of [
      { regulatory: { productType: 'local_fixture' } },
      { regulatory: { ...body.regulatory, manufacturer: undefined } },
      { regulatory: { ...body.regulatory, unknown: true } },
      { policyId: VARIANT + '\n' },
      { policyId: 'a2000000-0000-4000-8000-000000000037'.toUpperCase() },
      { regulatory: { ...body.regulatory, manufacturer: '\tName' } },
      { regulatory: { ...body.regulatory, safetyInstructions: 'bad\x00text' } }
    ]) {
      expect(policyAssignInputSchema.safeParse({ ...body, ...patch }).success).toBe(false)
    }
    expect(
      policyAssignInputSchema.safeParse({
        ...body,
        regulatory: { ...body.regulatory, safetyInstructions: 'line1\r\nline2\t' }
      }).success
    ).toBe(true)
  })
  it('all command bodies reject unknown keys and invalid zero versions except create', () => {
    const bodies = [
      [policyWithdrawInputSchema, { expectedVersion: 1, reason: REASON }],
      [exceptionWithdrawInputSchema, { expectedVersion: 1, reason: REASON }],
      [
        exceptionCreateInputSchema,
        {
          expectedVersion: 1,
          variantId: VARIANT,
          reason: REASON,
          evidenceReference: 'Ref',
          validFrom: input().validFrom,
          validUntil: null
        }
      ]
    ] as const
    for (const [schema, body] of bodies) {
      expect(schema.safeParse({ ...body, extra: true }).success).toBe(false)
      expect(schema.safeParse({ ...body, expectedVersion: 0 }).success).toBe(false)
      expect(schema.safeParse({ ...body, reason: '\t' + REASON }).success).toBe(false)
    }
  })
})
