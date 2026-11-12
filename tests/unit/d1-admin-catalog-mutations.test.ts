import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  AdminCatalogMutationError,
  draftProductMetadataSchema,
  updateD1DraftProductMetadata
} from '../../workers/catalog/admin-catalog-mutations'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { testUuid, testNow } from '../support/deterministic'

const IDENTITY = '10000000-0000-4000-8000-000000000034'
const SESSION = '20000000-0000-4000-8000-000000000034'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const REASON = 'Independent synthetic editorial review'
const ORIGINAL_ATTRIBUTES = {
  badges: ['eco'],
  visual: { type: 'cubo', color: '#123456', retainedVisualExtra: { source: 'legacy' } },
  attrs: [{ k: 'Material', v: 'Acero' }],
  image: '/img/products/unchanged.webp',
  imageAlt: 'Unchanged licensed product image',
  imageRights: { owner: 'Synthetic owner', license: 'Synthetic license', authorizedAt: '2026-09-01' },
  unknownNested: { values: [1, null, { preserved: true }] }
}

function utc(milliseconds = testNow()) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// No fake timers: production paths execute authorization against SQLite's real clock.
describe('D1 draft metadata mutations against every real migration', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    const past = utc(testNow() - 86400_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?, 'catalog-mutation@example.invalid', 'synthetic-not-a-login-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, past, past, past)
    sqlite.exec(`
      INSERT INTO roles VALUES ('mutation_editor', 'Editor', 'Independent local fixture');
      INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Independent local fixture'),
        ('catalog.read', 'catalog', 'read', 'Independent local fixture');
      INSERT INTO role_permissions VALUES ('mutation_editor', 'catalog.write'), ('mutation_editor', 'catalog.read');
      INSERT INTO categories(id,legacy_id,name,slug,status) VALUES
        ('category-draft', 8, 'Draft category', 'draft-category', 'draft'),
        ('category-review', 9, 'Review category', 'review-category', 'review'),
        ('category-hidden', 10, 'Hidden category', 'hidden-category', 'hidden'),
        ('category-discontinued', 12, 'Discontinued category', 'discontinued-category', 'discontinued'),
        ('category-unmapped', NULL, 'Unmapped category', 'unmapped-category', 'draft');
    `)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, 'mutation_editor', ?)")
      .run(IDENTITY, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(SESSION, IDENTITY, past, utc(testNow() + 3600_000))
    sqlite
      .prepare(
        `UPDATE products SET status='draft', brand_id='b1', short_description='Original short description',
      description='Original long description', usage='Original usage', series='Original series',
      featured=0, attributes=?, regulatory='{"classification":"unchanged-regulatory-evidence"}',
      source_version='unchanged-source-version', published_at=NULL WHERE id='p-1'`
      )
      .run(JSON.stringify(ORIGINAL_ATTRIBUTES))
    sqlite.exec(`INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
      VALUES ('unchanged-price-version','v-1-1',700,'[]','2026-08-12T00:00:00Z','approved',
        'Synthetic existing governed price','2026-08-12T00:00:00Z');`)
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })

  function product() {
    return sqlite.prepare("SELECT * FROM products WHERE id='p-1'").get()!
  }
  function version() {
    return Number(product().catalog_version)
  }
  function input(patch: Record<string, unknown> = { name: 'Changed draft title' }) {
    return { expectedVersion: version(), reason: REASON, ...patch }
  }
  function mutate(
    payload: unknown = input(),
    options: { key?: string; id?: string; database?: D1Database; claims?: typeof CLAIMS } = {}
  ) {
    return updateD1DraftProductMetadata(
      options.database ?? database,
      options.claims ?? CLAIMS,
      options.id ?? '1',
      payload,
      {
        idempotencyKey: options.key ?? testUuid()
      }
    )
  }
  function counts() {
    return sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM catalog_draft_commands) AS commands,
      (SELECT count(*) FROM catalog_draft_audit) AS audits,
      (SELECT count(*) FROM catalog_draft_guards) AS guards`
      )
      .get()!
  }
  function protectedState() {
    return Object.fromEntries(
      [
        'variants',
        'variant_price_versions',
        'tax_classes',
        'shipping_profiles',
        'inventory_balances',
        'inventory_movements',
        'inventory_reservations',
        'media_uploads',
        'media_scan_receipts',
        'media_rights_decisions',
        'product_media_publications',
        'product_media_publication_events',
        'categories'
      ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
    )
  }
  function beforeBatch(action: () => void): D1Database {
    const batch = database.batch.bind(database)
    return {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        action()
        return batch<T>(statements)
      }
    } as D1Database
  }
  function serializedBatches(): D1Database {
    const batch = database.batch.bind(database)
    let preceding = Promise.resolve()
    return {
      ...database,
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
    } as D1Database
  }
  async function rejected(payload: unknown, code = 'invalid_input', options: Parameters<typeof mutate>[1] = {}) {
    const before = product()
    const beforeCounts = counts()
    const operation = mutate(payload, options)
    await expect(operation).rejects.toBeInstanceOf(AdminCatalogMutationError)
    await expect(operation).rejects.toMatchObject({ code })
    expect(product()).toEqual(before)
    expect(counts()).toEqual(beforeCounts)
  }
  function ftsIntegrity() {
    expect(() => sqlite.exec("INSERT INTO products_fts(products_fts,rank) VALUES ('integrity-check',1)")).not.toThrow()
  }

  it('updates all ten permitted fields and only those fields with an immutable attributed audit and exact receipt', async () => {
    const before = product()
    const protectedBefore = protectedState()
    const oldVersion = version()
    const patch = {
      name: 'New draft product title',
      categoryId: 8,
      shortDesc: 'New short description',
      description: 'New full description\nSecond paragraph',
      usage: 'New professional usage',
      series: 'New series',
      featured: true,
      badges: ['concentrado', 'eco'],
      visual: { type: 'garrafa', color: '#Aa12Ff' },
      attrs: [
        { k: 'Volumen', v: 'Cinco litros' },
        { k: 'Material', v: 'Polietileno' }
      ]
    }
    const result = await mutate(input(patch), { key: 'all-ten-fields' })
    expect(result).toEqual({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: oldVersion + 1,
      updated: true
    })
    expect(Object.keys(result).sort()).toEqual(['catalogVersion', 'productId', 'productUuid', 'source', 'updated'])
    const after = product()
    expect(after).toMatchObject({
      name: patch.name,
      category_id: 'category-draft',
      short_description: patch.shortDesc,
      description: patch.description,
      usage: patch.usage,
      series: patch.series,
      featured: 1,
      catalog_version: oldVersion + 1
    })
    expect(JSON.parse(String(after.attributes))).toEqual({
      ...ORIGINAL_ATTRIBUTES,
      badges: patch.badges,
      visual: { ...ORIGINAL_ATTRIBUTES.visual, ...patch.visual },
      attrs: patch.attrs
    })
    const mutable = new Set([
      'name',
      'category_id',
      'short_description',
      'description',
      'usage',
      'series',
      'featured',
      'attributes',
      'catalog_version',
      'updated_at'
    ])
    expect(Object.fromEntries(Object.entries(after).filter(([field]) => !mutable.has(field)))).toEqual(
      Object.fromEntries(Object.entries(before).filter(([field]) => !mutable.has(field)))
    )
    expect(protectedState()).toEqual(protectedBefore)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    const command = sqlite.prepare('SELECT * FROM catalog_draft_commands').get()!
    const audit = sqlite.prepare('SELECT * FROM catalog_draft_audit').get()!
    expect(command).toMatchObject({
      actor_id: IDENTITY,
      product_id: 'p-1',
      product_legacy_id: 1,
      idempotency_key: 'all-ten-fields',
      expected_version: oldVersion,
      result_version: oldVersion + 1,
      reason: REASON
    })
    expect(String(command.payload_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(String(command.claim_nonce)).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(String(command.response))).toEqual(result)
    expect(audit).toMatchObject({
      command_id: command.id,
      actor_id: IDENTITY,
      product_id: 'p-1',
      product_legacy_id: 1,
      before_version: oldVersion,
      after_version: oldVersion + 1,
      reason: REASON
    })
    expect(JSON.parse(String(audit.before_metadata))).toMatchObject({ name: before.name })
    expect(JSON.parse(String(audit.after_metadata))).toMatchObject({ name: patch.name })
    ftsIntegrity()
  })

  it('does not default omitted metadata or replace unrelated JSON/visual leaves', async () => {
    const before = product()
    await mutate(input({ visual: { type: 'cubo', color: '#112233' } }))
    expect(JSON.parse(String(product().attributes))).toEqual({
      ...ORIGINAL_ATTRIBUTES,
      visual: { ...ORIGINAL_ATTRIBUTES.visual, color: '#112233' }
    })
    for (const field of [
      'name',
      'category_id',
      'short_description',
      'description',
      'usage',
      'series',
      'featured',
      'regulatory'
    ]) {
      expect(product()[field]).toBe(before[field])
    }
    await mutate(input({ name: 'Another permitted draft title' }))
    expect(JSON.parse(String(product().attributes))).toEqual({
      ...ORIGINAL_ATTRIBUTES,
      visual: { ...ORIGINAL_ATTRIBUTES.visual, color: '#112233' }
    })
  })

  it.each(['garrafa', 'botella', 'spray', 'caja', 'saco', 'capsulas', 'difusor', 'cubo', 'rollo', 'vaso', 'guante'])(
    'accepts the existing editor visual type %s without inventing another',
    async (type) => {
      await mutate(input({ visual: { type, color: '#123456' } }))
      expect(JSON.parse(String(product().attributes)).visual).toEqual({ ...ORIGINAL_ATTRIBUTES.visual, type })
    }
  )

  it.each([7, 8, 9, 10, 12])('maps existing category %i independent of its editorial status', async (categoryId) => {
    await mutate(input({ categoryId }))
    expect(product().category_id).toBe(
      sqlite.prepare('SELECT id FROM categories WHERE legacy_id=?').get(categoryId)!.id
    )
  })

  it.each(['review', 'published', 'hidden', 'discontinued'])('never edits a %s product', async (status) => {
    sqlite.prepare("UPDATE products SET status=? WHERE id='p-1'").run(status)
    await rejected(input(), 'product_not_editable')
  })

  it.each([
    '0',
    '01',
    '-1',
    '1.0',
    '1e0',
    '+1',
    ' 1',
    '1 ',
    '1\n',
    '1\r\n',
    'p-1',
    'producto-1',
    '9007199254740992',
    ''
  ])('rejects noncanonical product mapping %j', async (id) => {
    await rejected(input(), 'invalid_input', { id })
  })

  it('returns not found for missing safely mapped product IDs', async () => {
    await rejected(input(), 'not_found', { id: '99' })
  })

  it('rejects nonexistent target categories and stale optimistic versions without writes', async () => {
    await rejected(input({ categoryId: 999 }), 'invalid_input')
    await rejected(input({ name: 'Changed draft title', expectedVersion: version() - 1 }), 'version_conflict')
    await rejected(input({ name: 'Changed draft title', expectedVersion: version() + 1 }), 'version_conflict')
  })

  it('accepts null-prototype plain own-data objects without inheriting defaults', async () => {
    const payload = Object.assign(
      Object.create(null),
      input({ visual: Object.assign(Object.create(null), { type: 'cubo', color: '#223344' }) })
    )
    await mutate(payload)
    expect(JSON.parse(String(product().attributes)).visual).toEqual({ ...ORIGINAL_ATTRIBUTES.visual, color: '#223344' })
  })

  it.each([
    'id',
    'uuid',
    'productId',
    'productUuid',
    'legacyId',
    'slug',
    'status',
    'active',
    'brand',
    'brandId',
    'variants',
    'prices',
    'price',
    'tax',
    'stock',
    'image',
    'imageAlt',
    'imageRights',
    'regulatory',
    'publishedAt',
    'sourceVersion',
    'catalogVersion',
    'metadata',
    'now',
    'actorId',
    'sessionId',
    'permission',
    'capabilities',
    '__proto__',
    'constructor'
  ])('rejects forbidden own field %s including undefined values', async (field) => {
    const payload = input()
    Object.defineProperty(payload, field, { value: undefined, enumerable: true })
    expect(draftProductMetadataSchema.safeParse(payload).success).toBe(false)
    await rejected(payload)
  })

  it.each([null, [], true, 1, 'title', new Date(testNow()), new String('title')])(
    'rejects non-object/plain payload %j',
    async (payload) => {
      await rejected(payload)
    }
  )

  it.each([
    { reason: undefined },
    { expectedVersion: undefined },
    { name: undefined },
    { name: null },
    { name: 123 },
    { name: true },
    { name: ['Product'] },
    { name: { toString: () => 'Product' } },
    { name: 'ab' },
    { name: 'a'.repeat(161) },
    { shortDesc: 'abcd' },
    { shortDesc: 's'.repeat(501) },
    { shortDesc: null },
    { description: 'abcd' },
    { description: 'd'.repeat(10001) },
    { description: null },
    { usage: 'u'.repeat(2001) },
    { usage: 1 },
    { series: 's'.repeat(161) },
    { series: false },
    { featured: 1 },
    { featured: 'true' },
    { categoryId: '8' },
    { categoryId: 0 },
    { categoryId: -1 },
    { categoryId: 8.5 },
    { categoryId: Number.MAX_SAFE_INTEGER + 1 },
    { expectedVersion: 0 },
    { expectedVersion: -1 },
    { expectedVersion: 1.1 },
    { expectedVersion: '1' },
    { expectedVersion: Number.MAX_SAFE_INTEGER },
    { expectedVersion: Infinity },
    { expectedVersion: NaN },
    { reason: 'ab' },
    { reason: 'r'.repeat(501) },
    { reason: 1 },
    { reason: 'No\nmultiline reason' },
    { reason: 'Control\0reason' },
    { reason: 'Control\u007freason' },
    { reason: '\nRaw exterior control reason\n' },
    { name: 'Control\0title' },
    { name: '\tRaw exterior control title' },
    { shortDesc: 'Control\ttext' },
    { badges: ['unknown'] },
    { badges: ['eco', 'eco'] },
    { badges: ['eco', 'alimentaria', 'concentrado', 'eco'] },
    { badges: 'eco' },
    { badges: [1] },
    { visual: {} },
    { visual: { type: 'cubo' } },
    { visual: { color: '#123456' } },
    { visual: null },
    { visual: { type: 'invented' } },
    { visual: { color: '#12345' } },
    { visual: { color: 'red' } },
    { visual: { color: '#gggggg' } },
    { visual: { type: 'cubo', color: '#123456\n' } },
    { visual: { type: 'cubo', color: '#123456\r\n' } },
    { visual: { type: 'cubo', image: '/evil' } },
    { attrs: [{ k: 'A', v: 'B', unknown: true }] },
    { attrs: [{ k: '', v: 'B' }] },
    { attrs: [{ k: 'k'.repeat(101), v: 'B' }] },
    { attrs: [{ k: 'A', v: '' }] },
    { attrs: [{ k: 'A', v: 'v'.repeat(1001) }] },
    { attrs: [{ k: 'A', v: 1 }] },
    { attrs: Array.from({ length: 51 }, (_, index) => ({ k: `Key ${index}`, v: 'Value' })) }
  ])('enforces strict bounded types without coercion: %j', async (patch) => {
    await rejected(input({ name: 'Changed draft title', ...patch }))
  })

  it('requires at least one permitted metadata key', async () => {
    await rejected({ expectedVersion: version(), reason: REASON })
  })

  it('does not inherit optional metadata or execute inherited required-field accessors', async () => {
    const previousFeatured = Object.getOwnPropertyDescriptor(Object.prototype, 'featured')
    const previousReason = Object.getOwnPropertyDescriptor(Object.prototype, 'reason')
    let inheritedAccessorCalled = false
    try {
      Object.defineProperty(Object.prototype, 'featured', { value: true, configurable: true })
      await mutate(input({ name: 'Own data title without inherited defaults' }))
      expect(product().featured).toBe(0)
      Object.defineProperty(Object.prototype, 'reason', {
        get: () => {
          inheritedAccessorCalled = true
          return REASON
        },
        configurable: true
      })
      await rejected({ expectedVersion: version(), name: 'Missing own required reason' })
      expect(inheritedAccessorCalled).toBe(false)
    } finally {
      if (previousFeatured) Object.defineProperty(Object.prototype, 'featured', previousFeatured)
      else Reflect.deleteProperty(Object.prototype, 'featured')
      if (previousReason) Object.defineProperty(Object.prototype, 'reason', previousReason)
      else Reflect.deleteProperty(Object.prototype, 'reason')
    }
  })

  it.each(['', 'k'.repeat(201), 'two words', 'invalid/key', 'invalid\nkey', 'valid-key\n', 'valid-key\r\n', 'á-key'])(
    'rejects malformed idempotency keys %j',
    async (key) => {
      await rejected(input(), 'invalid_input', { key })
    }
  )

  it('binds production SQL execution time as NULL and never depends on changes() or non-indexed FTS updates', async () => {
    const observed: Array<{ sql: string; parameters: unknown[] }> = []
    const observedDatabase = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        const bind = statement.bind.bind(statement)
        statement.bind = (...parameters: unknown[]) => {
          observed.push({ sql, parameters })
          return bind(...parameters)
        }
        return statement
      }
    } as D1Database
    await mutate(input(), { database: observedDatabase })
    const actorStatements = observed.filter(({ sql }) => sql.includes('WITH actor AS'))
    expect(actorStatements.length).toBeGreaterThanOrEqual(5)
    for (const { sql, parameters } of actorStatements) {
      expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
      expect(parameters[0]).toBeNull()
      expect(sql).not.toMatch(/\bchanges\s*\(/i)
    }
    const ftsTrigger = String(
      sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='products_fts_update'").get()!.sql
    )
    expect(
      ftsTrigger
        .match(/AFTER UPDATE OF (.*?) ON products/s)?.[1]
        ?.replaceAll(/\s+/g, '')
        .split(',')
    ).toEqual(['name', 'short_description', 'description', 'usage'])
    ftsIntegrity()
  })

  it.each(['prototype', 'own getter', 'nested getter', 'symbol key', 'hidden forbidden key'])(
    'rejects %s without executing attacker accessors',
    async (kind) => {
      let accessed = false
      let payload: unknown = input()
      const getter = () => {
        accessed = true
        throw new Error('attacker accessor executed')
      }
      if (kind === 'prototype') payload = Object.assign(Object.create({ inherited: true }), payload)
      else if (kind === 'own getter') Object.defineProperty(payload, 'name', { get: getter, enumerable: true })
      else if (kind === 'nested getter') {
        const visual = { color: '#123456' }
        Object.defineProperty(visual, 'type', { get: getter, enumerable: true })
        payload = input({ visual })
      } else if (kind === 'symbol key')
        Object.defineProperty(payload, Symbol('actor'), { value: 'evil', enumerable: true })
      else Object.defineProperty(payload, 'status', { value: 'published', enumerable: false })
      await rejected(payload)
      expect(accessed).toBe(false)
    }
  )

  it('accepts exact field boundaries and intentional nullable/empty metadata without defaulting omitted fields', async () => {
    await mutate(
      input({
        name: 'n'.repeat(160),
        shortDesc: 's'.repeat(500),
        description: 'd'.repeat(10000),
        usage: 'u'.repeat(2000),
        series: 's'.repeat(160),
        reason: 'r'.repeat(500),
        badges: ['eco', 'alimentaria', 'concentrado'],
        attrs: Array.from({ length: 50 }, (_, index) => ({ k: `${index}`.padEnd(100, 'k'), v: 'v'.repeat(1000) }))
      })
    )
    await mutate(input({ usage: null, series: null, badges: [], attrs: [], featured: false }))
    expect(product()).toMatchObject({ usage: null, series: null, featured: 0 })
    expect(JSON.parse(String(product().attributes))).toMatchObject({ badges: [], attrs: [] })
    await mutate(input({ usage: '  ', series: ' ' }))
    expect(product()).toMatchObject({ usage: null, series: null })
  })

  it.each([
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["UPDATE identities SET status='disabled'", 'unauthenticated'],
    ["UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'unauthenticated'],
    ["UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'forbidden']
  ])('enforces live authority before writes: %s', async (sql, code) => {
    sqlite.exec(sql)
    await rejected(input(), code)
  })

  it.each([
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'unauthenticated'],
    ["UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 'forbidden']
  ])('SQL batch clock/authority recheck blocks a late change: %s', async (sql, code) => {
    await rejected(input(), code, { database: beforeBatch(() => sqlite.exec(sql)) })
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    ftsIntegrity()
  })

  it('rolls back product, command, audit and guard when audit insertion is forced to ABORT', async () => {
    const before = product()
    const protectedBefore = protectedState()
    sqlite.exec(`CREATE TRIGGER fixture_force_draft_audit_abort BEFORE INSERT ON catalog_draft_audit
      BEGIN SELECT RAISE(ABORT,'fixture_forced_catalog_audit_abort'); END;`)
    await expect(mutate()).rejects.toThrow()
    expect(product()).toEqual(before)
    expect(protectedState()).toEqual(protectedBefore)
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    ftsIntegrity()
  })

  it('never overwrites a product modified after preflight but before the guarded batch', async () => {
    let competingProduct: ReturnType<typeof product> | undefined
    const payload = input()
    const operation = mutate(payload, {
      database: beforeBatch(() => {
        sqlite.exec("UPDATE products SET name='Other writer title' WHERE id='p-1'")
        competingProduct = product()
      })
    })
    await expect(operation).rejects.toMatchObject({ code: 'version_conflict' })
    expect(product()).toEqual(competingProduct)
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
    ftsIntegrity()
  })

  it('never edits a product which leaves draft status after preflight', async () => {
    let competingProduct: ReturnType<typeof product> | undefined
    const operation = mutate(input(), {
      database: beforeBatch(() => {
        sqlite.exec("UPDATE products SET status='published' WHERE id='p-1'")
        competingProduct = product()
      })
    })
    await expect(operation).rejects.toMatchObject({ code: 'product_not_editable' })
    expect(product()).toEqual(competingProduct)
    expect(counts()).toEqual({ commands: 0, audits: 0, guards: 0 })
  })

  it('does not write to a target category deleted after preflight', async () => {
    await rejected(input({ categoryId: 8 }), 'invalid_input', {
      database: beforeBatch(() => sqlite.exec("DELETE FROM categories WHERE id='category-draft'"))
    })
  })

  it('replays the exact saved receipt before considering later product status/version/category state', async () => {
    const payload = input({ name: 'Original command title', categoryId: 8 })
    const first = await mutate(payload, { key: 'replay-after-changes' })
    await mutate(input({ name: 'Later editorial title' }), { key: 'later-command' })
    sqlite.exec(
      "UPDATE products SET status='published',category_id='c1' WHERE id='p-1'; UPDATE categories SET legacy_id=NULL WHERE id='category-draft';"
    )
    const beforeReplay = product()
    expect(await mutate(payload, { key: 'replay-after-changes' })).toEqual(first)
    expect(product()).toEqual(beforeReplay)
    expect(counts()).toEqual({ commands: 2, audits: 2, guards: 0 })
  })

  it('replay still requires current catalog.write, verified email and MFA', async () => {
    const payload = input()
    await mutate(payload, { key: 'auth-replay' })
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    await rejected(payload, 'forbidden', { key: 'auth-replay' })
  })

  it('hashes normalized owned fields rather than property insertion order', async () => {
    const old = version()
    const firstPayload = {
      expectedVersion: old,
      reason: `  ${REASON}  `,
      name: '  Trimmed canonical name  ',
      attrs: [{ k: '  Material  ', v: '  Steel  ' }],
      badges: ['eco', 'concentrado']
    }
    const first = await mutate(firstPayload, { key: 'canonical-payload-order' })
    expect(
      await mutate(
        {
          badges: ['eco', 'concentrado'],
          attrs: [{ v: 'Steel', k: 'Material' }],
          name: 'Trimmed canonical name',
          reason: REASON,
          expectedVersion: old
        },
        { key: 'canonical-payload-order' }
      )
    ).toEqual(first)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    await rejected({ ...firstPayload, badges: ['concentrado', 'eco'] }, 'idempotency_conflict', {
      key: 'canonical-payload-order'
    })
  })

  it('rejects same-key changed field, expected version, reason or target without further writes', async () => {
    const payload = input()
    await mutate(payload, { key: 'one-business-command' })
    for (const patch of [
      { name: 'Different payload' },
      { expectedVersion: version() },
      { reason: 'Different editorial reason' }
    ]) {
      await rejected({ ...payload, ...patch }, 'idempotency_conflict', { key: 'one-business-command' })
    }
    await rejected(payload, 'idempotency_conflict', { key: 'one-business-command', id: '2' })
  })

  it('produces one committed command/audit and identical receipt in a same-key same-payload race', async () => {
    const payload = input()
    const old = version()
    const parallel = serializedBatches()
    const results = await Promise.all([
      mutate(payload, { database: parallel, key: 'identical-race' }),
      mutate({ ...payload }, { database: parallel, key: 'identical-race' })
    ])
    expect(results[0]).toEqual(results[1])
    expect(version()).toBe(old + 1)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
  })

  it('never applies the losing payload of a different-payload same-key race', async () => {
    const payload = input()
    const old = version()
    const parallel = serializedBatches()
    const results = await Promise.allSettled([
      mutate(payload, { database: parallel, key: 'different-race' }),
      mutate({ ...payload, name: 'Other competing title' }, { database: parallel, key: 'different-race' })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'idempotency_conflict' }
    })
    expect(version()).toBe(old + 1)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    const saved = sqlite.prepare('SELECT after_metadata FROM catalog_draft_audit').get()!
    expect(JSON.parse(String(saved.after_metadata)).name).toBe(product().name)
  })

  it('does not steal a preexisting claim nonce or return its unaudited receipt as completed work', async () => {
    const before = product()
    let capturedClaim: { sql: string; parameters: SQLInputValue[] } | undefined
    let foreignClaim: Record<string, unknown> | undefined
    const batch = database.batch.bind(database)
    const racedDatabase = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        const bind = statement.bind.bind(statement)
        statement.bind = (...parameters: unknown[]) => {
          if (sql.includes('INSERT INTO catalog_draft_commands'))
            capturedClaim = { sql, parameters: parameters as SQLInputValue[] }
          return bind(...parameters)
        }
        return statement
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        expect(capturedClaim).toBeDefined()
        const foreignParameters = [...capturedClaim!.parameters]
        foreignParameters[12] = testUuid()
        // This isolated adversarial partial claim is inserted OUTSIDE the API
        // batch; it must not acquire the fresh command's private nonce.
        sqlite.prepare(capturedClaim!.sql).run(...foreignParameters)
        foreignClaim = sqlite.prepare('SELECT * FROM catalog_draft_commands').get()
        return batch<T>(statements)
      }
    } as D1Database
    await expect(mutate(input(), { database: racedDatabase, key: 'foreign-partial-claim' })).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(product()).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM catalog_draft_commands').get()).toEqual(foreignClaim)
    expect(counts()).toEqual({ commands: 1, audits: 0, guards: 0 })
    ftsIntegrity()
  })

  it('a two-key version race commits only one update/audit', async () => {
    const payload = input()
    const old = version()
    const parallel = serializedBatches()
    const results = await Promise.allSettled([
      mutate(payload, { database: parallel, key: 'cas-race-a' }),
      mutate({ ...payload, name: 'Other competing title' }, { database: parallel, key: 'cas-race-b' })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'version_conflict' }
    })
    expect(version()).toBe(old + 1)
    expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    ftsIntegrity()
  })

  it.each(['catalog_draft_commands', 'catalog_draft_audit'])(
    'keeps %s immutable against UPDATE/DELETE/REPLACE and alternate-ID business-key replacement',
    async (table) => {
      await mutate(input(), { key: 'immutable-receipt' })
      const row = sqlite.prepare(`SELECT * FROM ${table}`).get()!
      expect(() => sqlite.prepare(`UPDATE ${table} SET reason='Altered reason' WHERE id=?`).run(row.id)).toThrow()
      expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id)).toThrow()
      const fields = Object.keys(row)
      const values = Object.values(row) as SQLInputValue[]
      const replace = sqlite.prepare(
        `INSERT OR REPLACE INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
      )
      expect(() => replace.run(...values)).toThrow()
      values[fields.indexOf('id')] = testUuid()
      expect(() => replace.run(...values)).toThrow()
      expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([row])
      expect(counts()).toEqual({ commands: 1, audits: 1, guards: 0 })
    }
  )

  it.each([0, 1])(
    'has exact version increments, external no-op semantics and sound FTS with recursive_triggers=%i',
    async (recursive) => {
      sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
      const old = version()
      await mutate(input({ name: 'Distinctftskeyword new title' }))
      expect(version()).toBe(old + 1)
      expect(
        sqlite.prepare("SELECT rowid FROM products_fts WHERE products_fts MATCH 'distinctftskeyword'").all()
      ).toHaveLength(1)
      ftsIntegrity()
      sqlite.exec(
        "UPDATE products SET name=name,short_description=short_description,updated_at='2026-09-30T00:00:00Z' WHERE id='p-1'"
      )
      expect(version()).toBe(old + 1)
      ftsIntegrity()
      sqlite.exec("UPDATE products SET series='Substantive external change' WHERE id='p-1'")
      expect(version()).toBe(old + 2)
      ftsIntegrity()
      sqlite.exec("UPDATE products SET description='Externalftskeyword indexed change' WHERE id='p-1'")
      expect(version()).toBe(old + 3)
      expect(
        sqlite.prepare("SELECT rowid FROM products_fts WHERE products_fts MATCH 'externalftskeyword'").all()
      ).toHaveLength(1)
      ftsIntegrity()
      const current = version()
      await mutate(input({ name: String(product().name) }))
      expect(version()).toBe(current + 1)
      ftsIntegrity()
      expect(() => sqlite.prepare("UPDATE products SET catalog_version=? WHERE id='p-1'").run(current)).toThrow()
      expect(version()).toBe(current + 1)
      expect(() => sqlite.prepare("UPDATE products SET catalog_version=? WHERE id='p-1'").run(current + 3)).toThrow()
      expect(version()).toBe(current + 1)
    }
  )

  it.each([0, 1])('rejects version overflow at the SQL boundary with recursive_triggers=%i', (recursive) => {
    sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
    const maximum = Number.MAX_SAFE_INTEGER
    const insertGuard = String(
      sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='products_catalog_version_insert'").get()!.sql
    )
    // Controlled ceiling fixture setup only; restore the exact migrated trigger
    // before any operation under test. Production cannot insert a forged version.
    sqlite.exec('DROP TRIGGER products_catalog_version_insert')
    sqlite
      .prepare(
        `INSERT INTO products(id,legacy_id,category_id,name,slug,status,catalog_version)
      VALUES ('overflow-product',999,'c1','Overflow fixture','overflow-fixture','draft',?)`
      )
      .run(maximum)
    sqlite.exec(insertGuard)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,name,slug,status,catalog_version)
      VALUES ('forged-version',1000,'c1','Forged fixture','forged-version-fixture','draft',?)`
        )
        .run(maximum)
    ).toThrow()
    const before = sqlite.prepare("SELECT * FROM products WHERE id='overflow-product'").get()
    expect(() =>
      sqlite.exec("UPDATE products SET name='Overflow substantive update' WHERE id='overflow-product'")
    ).toThrow()
    expect(sqlite.prepare("SELECT * FROM products WHERE id='overflow-product'").get()).toEqual(before)
    expect(() =>
      sqlite.prepare("UPDATE products SET catalog_version=? WHERE id='overflow-product'").run(maximum + 1)
    ).toThrow()
    ftsIntegrity()
  })

  it('reapplying real generated seeds is version-idempotent without fabricating editorial approval/audits', async () => {
    const seedDatabase = await openMigratedDatabase()
    try {
      seedDatabase.exec(renderD1CategorySeed())
      seedDatabase.exec(renderD1ProductSeed())
      const before = seedDatabase.prepare('SELECT id,catalog_version FROM products ORDER BY id').all()
      seedDatabase.exec(renderD1ProductSeed())
      expect(seedDatabase.prepare('SELECT id,catalog_version FROM products ORDER BY id').all()).toEqual(before)
      expect(
        seedDatabase
          .prepare(
            `SELECT (SELECT count(*) FROM catalog_draft_commands) AS commands,
        (SELECT count(*) FROM catalog_draft_audit) AS audits`
          )
          .get()
      ).toEqual({ commands: 0, audits: 0 })
      expect(() =>
        seedDatabase.exec("INSERT INTO products_fts(products_fts,rank) VALUES ('integrity-check',1)")
      ).not.toThrow()
    } finally {
      seedDatabase.close()
    }
  })
})
