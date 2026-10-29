import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogDraftAuthoringError,
  executeD1CatalogDraftAuthoringCommand
} from '../../workers/catalog/admin-catalog-authoring'
import {
  createDraftInputSchema,
  createVariantInputSchema,
  updateVariantInputSchema,
  assignBrandInputSchema,
  discontinueVariantInputSchema,
  type CatalogDraftAuthoringAction,
  type CreateDraftInput,
  type DraftVariantInput
} from '../../shared/catalog-draft-authoring'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

const IDENTITY = '10000000-0000-4000-8000-000000000038'
const SESSION = '20000000-0000-4000-8000-000000000038'
const CATEGORY = '30000000-0000-4000-8000-000000000038'
const BRAND = '40000000-0000-4000-8000-000000000038'
const TAX = '50000000-0000-4000-8000-000000000038'
const SHIPPING = '60000000-0000-4000-8000-000000000038'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const REASON = 'Synthetic local draft authoring decision'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const variant = (overrides: Partial<DraftVariantInput> = {}): DraftVariantInput => ({
  sku: 'DRAFT-INITIAL',
  format: 'Botella 1 L',
  ean: null,
  gtin: null,
  mpn: null,
  taxClassId: TAX,
  shippingProfileId: SHIPPING,
  unitBase: 'L',
  unitLabel: 'litro',
  contentQuantity: 1,
  unitsPerCase: 6,
  casesPerPallet: null,
  minimumQuantity: 1,
  quantityIncrement: 1,
  maximumQuantity: null,
  weightGrams: 1100,
  widthMm: 100,
  heightMm: 200,
  depthMm: 100,
  backorderAllowed: false,
  leadTimeDays: null,
  color: null,
  ...overrides
})
const draft = (overrides: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  expectedVersion: 0,
  reason: REASON,
  name: 'Draft synthetic product',
  categoryId: 10,
  brandId: BRAND,
  shortDesc: 'Synthetic local draft description',
  description: 'Synthetic local-only draft, without publication authority.',
  usage: null,
  series: null,
  featured: false,
  badges: [],
  visual: { type: 'botella', color: '#00aa00' },
  attrs: [],
  initialVariant: variant(),
  ...overrides
})

// Explicit ephemeral catalog references, not publication/scanner/rights approvals.
describe('D1 draft authoring atomic engine', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_draft_authoring_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0038_catalog_draft_authoring.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,10,'Draft category','draft-category','draft')"
      )
      .run(CATEGORY)
    sqlite.prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Draft brand','draft-brand','draft')").run(BRAND)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'DRAFT-ZERO','Zero valid tax',0,'2020-01-01T00:00:00Z')"
      )
      .run(TAX)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'DRAFT-SHIP','Draft shipping','parcel')")
      .run(SHIPPING)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('draft-warehouse','DRAFT-WH','Only warehouse','warehouse',1,?)"
      )
      .run(utc(-86400_000))
    const past = utc(-86400_000)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'draft-author@example.invalid','synthetic-test-only',?,'active',?,?)"
      )
      .run(IDENTITY, past, past, past)
    sqlite.exec(
      "INSERT INTO roles VALUES ('draft_author','Draft author','Synthetic fixture'); INSERT INTO permissions VALUES ('catalog.write','catalog','write','Draft write'); INSERT INTO role_permissions VALUES ('draft_author','catalog.write');"
    )
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'draft_author',?)")
      .run(IDENTITY, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(SESSION, IDENTITY, past, utc(3600_000))
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  function execute(
    action: CatalogDraftAuthoringAction,
    target: { productId?: string; variantId?: string },
    input: unknown,
    opts: { key?: string; db?: D1Database; claims?: typeof CLAIMS | null; now?: string } = {}
  ) {
    return executeD1CatalogDraftAuthoringCommand(
      opts.db ?? database,
      opts.claims === undefined ? CLAIMS : opts.claims,
      action,
      target,
      input,
      { idempotencyKey: opts.key ?? crypto.randomUUID(), ...(opts.now === undefined ? {} : { now: opts.now }) }
    )
  }
  const create = (input = draft(), opts: { key?: string; db?: D1Database } = {}) =>
    execute('create_draft', {}, input, opts)
  function rows() {
    return {
      products: sqlite.prepare('SELECT * FROM products ORDER BY id').all(),
      variants: sqlite.prepare('SELECT * FROM variants ORDER BY id').all(),
      balances: sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all(),
      counters: sqlite.prepare('SELECT * FROM catalog_draft_legacy_counters ORDER BY entity').all(),
      commands: sqlite.prepare('SELECT * FROM catalog_draft_authoring_commands ORDER BY id').all(),
      audits: sqlite.prepare('SELECT * FROM catalog_draft_authoring_audit ORDER BY id').all(),
      prices: sqlite.prepare('SELECT * FROM variant_price_versions ORDER BY id').all(),
      movements: sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all()
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
  function beforeBatch(effect: () => void) {
    return proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        effect()
        return database.batch<T>(statements)
      }
    })
  }
  async function add(productId: number, version: number, sku = 'DRAFT-SECOND') {
    return execute(
      'create_variant',
      { productId: String(productId) },
      { expectedVersion: version, reason: REASON, ...variant({ sku }) }
    )
  }
  function serialized() {
    let previous = Promise.resolve()
    return proxy({
      async batch<T>(statements: D1PreparedStatement[]) {
        const waiting = previous
        let release!: () => void
        previous = new Promise<void>((resolve) => {
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
  function price(variantUuid: string, tiers: unknown, window: 'current' | 'future' | 'past' = 'current') {
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,valid_until,status,reason,created_at)
      VALUES (?,?,500,?,?,?,'approved',?,?)`
      )
      .run(
        crypto.randomUUID(),
        variantUuid,
        JSON.stringify(tiers),
        utc(window === 'future' ? 3600_000 : -7200_000),
        window === 'past' ? utc(-3600_000) : null,
        REASON,
        utc(-10800_000)
      )
  }
  function reservation(variantUuid: string, status: 'reserved' | 'released' = 'reserved') {
    const id = crypto.randomUUID()
    sqlite
      .prepare(
        `INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at,released_at)
      VALUES (?,? ,?,?, 'synthetic',?,?,?,?)`
      )
      .run(
        id,
        id,
        '0'.repeat(64),
        status,
        utc(-3600_000),
        utc(-7200_000),
        utc(-7200_000),
        status === 'released' ? utc(-1800_000) : null
      )
    sqlite
      .prepare(
        "INSERT INTO inventory_reservation_lines(reservation_id,variant_id,location_id,quantity) VALUES (?,?,'draft-warehouse',1)"
      )
      .run(id, variantUuid)
  }
  function captured() {
    const bound = new WeakMap<D1PreparedStatement, readonly unknown[]>()
    const db = proxy({
      prepare(sql: string) {
        const statement = database.prepare(sql)
        return new Proxy(statement, {
          get(target, key) {
            if (key === 'bind')
              return (...parameters: unknown[]) => {
                bound.set(target, parameters)
                return target.bind(...parameters)
              }
            const value: unknown = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    })
    return { db, bound }
  }

  it.each(['draft', 'review', 'hidden'])('accepts an existing non-discontinued category in %s', async (status) => {
    sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, CATEGORY)
    expect((await create()).catalogVersion).toBe(1)
  })
  it.each([
    'missing_category',
    'retired_category',
    'archived_brand',
    'missing_tax',
    'expired_tax',
    'future_tax',
    'missing_shipping',
    'no_warehouse',
    'two_warehouses'
  ])('rejects unavailable explicit references: %s', async (condition) => {
    const input = draft()
    if (condition === 'missing_category') input.categoryId = 999
    if (condition === 'retired_category')
      sqlite.prepare("UPDATE categories SET status='discontinued' WHERE id=?").run(CATEGORY)
    if (condition === 'archived_brand') sqlite.prepare("UPDATE brands SET status='archived' WHERE id=?").run(BRAND)
    if (condition === 'missing_tax') input.initialVariant.taxClassId = crypto.randomUUID()
    if (condition === 'expired_tax')
      sqlite.prepare('UPDATE tax_classes SET valid_until=? WHERE id=?').run(utc(-1000), TAX)
    if (condition === 'future_tax')
      sqlite.prepare('UPDATE tax_classes SET valid_from=? WHERE id=?').run(utc(3600_000), TAX)
    if (condition === 'missing_shipping') input.initialVariant.shippingProfileId = crypto.randomUUID()
    if (condition === 'no_warehouse') sqlite.exec('UPDATE inventory_locations SET active=0')
    if (condition === 'two_warehouses')
      sqlite
        .prepare(
          "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('other','OTHER','Other','warehouse',1,?)"
        )
        .run(utc(-1000))
    const before = rows()
    await expect(create(input)).rejects.toMatchObject({ code: 'reference_unavailable' })
    expect(rows()).toEqual(before)
  })
  it.each(['published', 'review', 'hidden', 'discontinued'])('new authoring cannot edit product %s', async (status) => {
    const initial = await create()
    sqlite.prepare('UPDATE products SET status=? WHERE id=?').run(status, initial.productUuid)
    const before = rows()
    await expect(
      execute(
        'update_variant',
        { productId: '1', variantId: '1' },
        { expectedVersion: 2, reason: REASON, format: 'Changed' }
      )
    ).rejects.toMatchObject({ code: 'product_not_editable' })
    expect(rows()).toEqual(before)
  })
  it('never retires the last variant or resurrects a retired variant', async () => {
    const initial = await create()
    await expect(
      execute('discontinue_variant', { productId: '1', variantId: '1' }, { expectedVersion: 1, reason: REASON })
    ).rejects.toMatchObject({ code: 'variant_not_editable' })
    const second = await add(1, 1)
    await execute(
      'discontinue_variant',
      { productId: '1', variantId: String(second.variantId) },
      { expectedVersion: 2, reason: REASON }
    )
    const before = rows()
    await expect(
      execute(
        'update_variant',
        { productId: '1', variantId: String(second.variantId) },
        { expectedVersion: 3, reason: REASON, format: 'Resurrect' }
      )
    ).rejects.toMatchObject({ code: 'variant_not_editable' })
    expect(rows()).toEqual(before)
    expect(rows().variants.find((item) => item.id === initial.variantUuid)?.status).toBe('draft')
  })
  it('rejects foreign variant ownership and stale versions without writes', async () => {
    await create()
    const other = await create(draft({ name: 'Other draft', initialVariant: variant({ sku: 'OTHER-SKU' }) }))
    const before = rows()
    await expect(
      execute(
        'update_variant',
        { productId: '1', variantId: String(other.variantId) },
        { expectedVersion: 1, reason: REASON, format: 'Foreign' }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      execute('assign_brand', { productId: '1' }, { expectedVersion: 2, reason: REASON, brandId: BRAND })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(rows()).toEqual(before)
  })
  it('preserves price histories, stock and unknown product/variant fields on partial metadata edits', async () => {
    const initial = await create()
    sqlite
      .prepare(
        "UPDATE products SET attributes=json_set(attributes,'$.media',json('{\"pin\":null}')),regulatory=? WHERE id=?"
      )
      .run('{"unknown":[null,true]}', initial.productUuid)
    sqlite
      .prepare(
        "UPDATE variants SET image='/img/products/legacy.png',price_gross_cents=999,compare_at_gross_cents=1200,cost_net_cents=450,safety_stock=0 WHERE id=?"
      )
      .run(initial.variantUuid)
    price(initial.variantUuid!, [{ minimumQuantity: 6, unitGrossCents: 450 }])
    const before = rows()
    await execute(
      'update_variant',
      { productId: '1', variantId: '1' },
      { expectedVersion: 2, reason: REASON, mpn: 'Explicit MPN', color: '#aabbcc' }
    )
    const after = rows()
    expect(after.products[0]).toMatchObject({
      attributes: before.products[0]?.attributes,
      regulatory: before.products[0]?.regulatory,
      slug: before.products[0]?.slug
    })
    expect(after.variants[0]).toMatchObject({
      id: initial.variantUuid,
      legacy_id: 1,
      sku: 'DRAFT-INITIAL',
      price_gross_cents: 999,
      compare_at_gross_cents: 1200,
      cost_net_cents: 450,
      image: '/img/products/legacy.png'
    })
    expect(after.prices).toEqual(before.prices)
    expect(after.balances).toEqual(before.balances)
    expect(after.movements).toEqual(before.movements)
  })
  it('distinguishes omitted nullable data from explicit clearing', async () => {
    await create(draft({ initialVariant: variant({ mpn: 'Original MPN', color: '#00aa00', maximumQuantity: 12 }) }))
    await execute(
      'update_variant',
      { productId: '1', variantId: '1' },
      { expectedVersion: 1, reason: REASON, format: 'New format' }
    )
    expect(rows().variants[0]).toMatchObject({ mpn: 'Original MPN', color: '#00aa00', maximum_quantity: 12 })
    await execute(
      'update_variant',
      { productId: '1', variantId: '1' },
      { expectedVersion: 2, reason: REASON, mpn: null, color: null, maximumQuantity: null }
    )
    expect(rows().variants[0]).toMatchObject({ mpn: null, color: null, maximum_quantity: null })
  })
  it.each(['current', 'future'] as const)(
    'checks %s governed volume tiers against merged MOQ/increment/maximum',
    async (window) => {
      const initial = await create()
      price(initial.variantUuid!, [{ minimumQuantity: 6, unitGrossCents: 450 }], window)
      const before = rows()
      for (const patch of [
        { minimumQuantity: 3, quantityIncrement: 2 },
        { minimumQuantity: 6 },
        { maximumQuantity: 5 }
      ]) {
        await expect(
          execute(
            'update_variant',
            { productId: '1', variantId: '1' },
            { expectedVersion: 1, reason: REASON, ...patch }
          )
        ).rejects.toMatchObject({ code: 'quantity_conflict' })
        expect(rows()).toEqual(before)
      }
      await execute(
        'update_variant',
        { productId: '1', variantId: '1' },
        { expectedVersion: 1, reason: REASON, minimumQuantity: 2, quantityIncrement: 2 }
      )
      expect(rows().prices).toEqual(before.prices)
    }
  )
  it('does not reinterpret cancelled or expired price history as current quantity policy', async () => {
    const initial = await create()
    price(initial.variantUuid!, [{ minimumQuantity: 2, unitGrossCents: 450 }], 'past')
    await execute(
      'update_variant',
      { productId: '1', variantId: '1' },
      { expectedVersion: 1, reason: REASON, minimumQuantity: 4, quantityIncrement: 2 }
    )
    expect(rows().prices).toHaveLength(1)
  })
  it.each(['update_variant', 'discontinue_variant'] as const)(
    'blocks %s while any persisted reserved line remains even after TTL',
    async (action) => {
      const initial = await create()
      await add(1, 1)
      reservation(initial.variantUuid!)
      const before = rows()
      await expect(
        execute(
          action,
          { productId: '1', variantId: '1' },
          { expectedVersion: 2, reason: REASON, ...(action === 'update_variant' ? { format: 'Changed' } : {}) }
        )
      ).rejects.toMatchObject({ code: 'quantity_conflict' })
      expect(rows()).toEqual(before)
    }
  )
  it('released reservation history does not block authoring or get mutated', async () => {
    const initial = await create()
    reservation(initial.variantUuid!, 'released')
    const before = sqlite.prepare('SELECT * FROM inventory_reservations').all()
    await execute(
      'update_variant',
      { productId: '1', variantId: '1' },
      { expectedVersion: 1, reason: REASON, minimumQuantity: 3 }
    )
    expect(sqlite.prepare('SELECT * FROM inventory_reservations').all()).toEqual(before)
  })
  it.each(['session_revoke', 'session_expire', 'grant_revoke', 'grant_expire', 'email', 'mfa'] as const)(
    'live batch authority rejects late %s with no effects',
    async (change) => {
      const before = rows()
      const drift = beforeBatch(() => {
        if (change === 'session_revoke')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), SESSION)
        if (change === 'session_expire')
          sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(-1000), SESSION)
        if (change === 'grant_revoke') sqlite.exec('DELETE FROM identity_roles')
        if (change === 'grant_expire') sqlite.prepare('UPDATE identity_roles SET expires_at=?').run(utc(-1000))
        if (change === 'email') sqlite.exec('UPDATE identities SET email_verified_at=NULL')
        if (change === 'mfa') sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      })
      await expect(create(draft(), { db: drift })).rejects.toMatchObject({
        code: change.startsWith('session')
          ? 'unauthenticated'
          : change.startsWith('grant')
            ? 'forbidden'
            : change === 'email'
              ? 'email_unverified'
              : 'mfa_required'
      })
      expect(rows()).toEqual(before)
    }
  )
  it('rolls back reference drift after claim, including allocated counters', async () => {
    sqlite.exec(
      `CREATE TRIGGER synthetic_tax_expiry AFTER INSERT ON catalog_draft_authoring_commands BEGIN UPDATE tax_classes SET valid_until=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='${TAX}'; END;`
    )
    const before = rows(),
      taxBefore = sqlite.prepare('SELECT * FROM tax_classes').all()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM tax_classes').all()).toEqual(taxBefore)
  })
  it('rolls back unexpected variant edits after owned CAS', async () => {
    const initial = await create()
    sqlite.exec(
      `CREATE TRIGGER synthetic_price_drift AFTER UPDATE OF format ON variants BEGIN UPDATE variants SET price_gross_cents=777 WHERE id=NEW.id; END;`
    )
    const before = rows()
    await expect(
      execute(
        'update_variant',
        { productId: '1', variantId: '1' },
        { expectedVersion: 1, reason: REASON, format: 'Changed' }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
    expect(initial.catalogVersion).toBe(1)
  })
  it('audit abort rolls back all domain rows and counter claims', async () => {
    sqlite.exec(
      "CREATE TRIGGER synthetic_audit_abort BEFORE INSERT ON catalog_draft_authoring_audit BEGIN SELECT RAISE(ABORT,'synthetic audit abort'); END;"
    )
    const before = rows()
    await expect(create()).rejects.toBeInstanceOf(CatalogDraftAuthoringError)
    expect(rows()).toEqual(before)
  })
  it('exact completed replay survives later version/status/reference changes, but not current authorization loss', async () => {
    const input = draft(),
      key = crypto.randomUUID(),
      first = await create(input, { key })
    sqlite.prepare("UPDATE products SET status='hidden' WHERE id=?").run(first.productUuid)
    sqlite.prepare("UPDATE brands SET status='archived' WHERE id=?").run(BRAND)
    const before = rows(),
      replayed = await create(input, { key })
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first))
    expect(rows()).toEqual(before)
    await expect(create({ ...input, name: 'Different name' }, { key })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    sqlite.exec('DELETE FROM identity_roles')
    await expect(create(input, { key })).rejects.toMatchObject({ code: 'forbidden' })
    expect(rows()).toEqual(before)
  })
  it('same key races return one exact immutable receipt', async () => {
    const db = serialized(),
      key = crypto.randomUUID()
    const [left, right] = await Promise.all([create(draft(), { key, db }), create(draft(), { key, db })])
    expect(JSON.stringify(left)).toBe(JSON.stringify(right))
    expect(rows().commands).toHaveLength(1)
    expect(rows().products).toHaveLength(1)
  })
  it('different create keys allocate globally unique IDs under a concurrent high-water race', async () => {
    const db = serialized()
    const receipts = await Promise.all([
      create(draft(), { db }),
      create(draft({ name: 'Other concurrent', initialVariant: variant({ sku: 'OTHER-CONCURRENT' }) }), { db })
    ])
    expect(receipts.map((item) => item.productId).sort()).toEqual([1, 2])
    expect(receipts.map((item) => item.variantId).sort()).toEqual([1, 2])
    expect(rows().commands).toHaveLength(2)
    expect(rows().audits).toHaveLength(2)
  })
  it('different variant commands on one expected product version have one winner', async () => {
    await create()
    const db = serialized()
    const results = await Promise.allSettled(
      ['ADD-A', 'ADD-B'].map((sku) =>
        execute(
          'create_variant',
          { productId: '1' },
          { expectedVersion: 1, reason: REASON, ...variant({ sku }) },
          { db }
        )
      )
    )
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((item) => item.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'version_conflict' })
    expect(rows().variants).toHaveLength(2)
    expect(rows().products[0]?.catalog_version).toBe(2)
  })
  it.each([0, 1])(
    'commands and audits resist UPDATE, DELETE and REPLACE with recursive_triggers=%s',
    async (recursive) => {
      sqlite.exec(`PRAGMA recursive_triggers=${recursive}`)
      await create()
      const before = rows()
      for (const table of ['catalog_draft_authoring_commands', 'catalog_draft_authoring_audit']) {
        expect(() => sqlite.exec(`UPDATE ${table} SET reason='Changed test reason'`)).toThrow()
        expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
        expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow()
      }
      expect(rows()).toEqual(before)
    }
  )
  it('does not turn a provider outage mentioning its table into a business conflict', async () => {
    const outage = new Error('catalog_draft_authoring_commands provider unavailable')
    const db = proxy({
      async batch() {
        throw outage
      }
    })
    await expect(create(draft(), { db })).rejects.toBe(outage)
    expect(rows().commands).toEqual([])
  })
  it('records original ownership but cannot recover an unaudited foreign claim as completed', async () => {
    const { db: observed, bound } = captured()
    const db = new Proxy(observed, {
      get(target, key) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
            const sql: unknown = Reflect.get(statements[0]!, 'sql'),
              parameters = bound.get(statements[0]!)
            if (typeof sql !== 'string' || !parameters) throw new Error('fixture_capture_missing')
            const foreign = [...parameters]
            foreign[12] = crypto.randomUUID()
            // Execute only the foreign immutable claim; the engine must neither
            // adopt its nonce nor treat its unaudited response as completion.
            await database
              .prepare(sql)
              .bind(...foreign)
              .all()
            return database.batch<T>(statements)
          }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(create(draft(), { db })).rejects.toMatchObject({ code: 'conflict' })
    expect(rows().commands).toHaveLength(1)
    expect(rows().audits).toEqual([])
    expect(rows().products).toEqual([])
    expect(rows().counters.map((row) => row.last_id)).toEqual([0, 0])
  })
  it('requires a matching audit even when a provider omits the audit statement', async () => {
    const { db: observed } = captured()
    const db = new Proxy(observed, {
      get(target, key) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
            database.batch<T>(
              statements.map((statement) => {
                const sql: unknown = Reflect.get(statement, 'sql')
                return typeof sql === 'string' && sql.includes('INSERT INTO catalog_draft_authoring_audit')
                  ? database.prepare('SELECT 1 AS no_audit')
                  : statement
              })
            )
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const before = rows()
    await expect(create(draft(), { db })).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
  })
  it('zero initial inventory cannot commit a fabricated movement from an unexpected trigger', async () => {
    sqlite.exec(`CREATE TRIGGER synthetic_zero_ledger AFTER INSERT ON inventory_balances BEGIN
      INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,reason,created_at)
      VALUES ('synthetic-movement',NEW.variant_id,NEW.location_id,'initial',1,0,'synthetic','synthetic-movement','synthetic','Unexpected fixture movement',NEW.created_at); END;`)
    const before = rows()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
  })
  it.each(['missing_flag', 'short_results'] as const)(
    'treats incomplete provider %s as unavailable, not success or a business conflict',
    async (kind) => {
      const db = proxy({
        async batch<T>(): Promise<D1Result<T>[]> {
          if (kind === 'short_results') return []
          // Deliberately malformed runtime response; no platform casts or fake
          // success normalization. The own-data result boundary must reject it.
          const malformed: D1Result<T> = {
            success: true,
            meta: {
              duration: 0,
              size_after: 0,
              rows_read: 0,
              rows_written: 0,
              last_row_id: 0,
              changed_db: false,
              changes: 0
            },
            results: []
          }
          Reflect.deleteProperty(malformed, 'success')
          return Array.from({ length: 9 }, () => malformed)
        }
      })
      await expect(create(draft(), { db })).rejects.toThrow('catalog_draft_write_unavailable')
      expect(rows().commands).toEqual([])
    }
  )
  it('resolves imported high-water IDs without reusing a legacy identity', async () => {
    const importedProduct = crypto.randomUUID(),
      importedVariant = crypto.randomUUID()
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES (?,9000,?,?,'Imported draft','imported-draft','draft')"
      )
      .run(importedProduct, CATEGORY, BRAND)
    sqlite
      .prepare(
        "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES (?,9001,?,?,?,'IMPORTED-SKU','Unit','draft',0)"
      )
      .run(importedVariant, importedProduct, TAX, SHIPPING)
    const created = await create()
    expect(created.productId).toBe(9001)
    expect(created.variantId).toBe(9002)
    expect(rows().products.find((item) => item.id === importedProduct)?.legacy_id).toBe(9000)
    expect(rows().variants.find((item) => item.id === importedVariant)?.legacy_id).toBe(9001)
    expect(() => sqlite.exec('UPDATE catalog_draft_legacy_counters SET last_id=0')).toThrow()
    expect(() => sqlite.exec("INSERT OR REPLACE INTO catalog_draft_legacy_counters VALUES ('product',1)")).toThrow()
  })
  it('allocates a unique server slug when both the base and legacy suffix already exist', async () => {
    const first = await create(draft({ name: 'Collision', initialVariant: variant({ sku: 'COLLISION-A' }) }))
    const second = await create(draft({ name: 'Collision 3', initialVariant: variant({ sku: 'COLLISION-B' }) }))
    const third = await create(draft({ name: 'Collision', initialVariant: variant({ sku: 'COLLISION-C' }) }))
    expect(third.productId).toBe(3)
    const sources = rows().products
    expect(sources.find((item) => item.id === first.productUuid)?.slug).toBe('collision')
    expect(sources.find((item) => item.id === second.productUuid)?.slug).toBe('collision-3')
    expect(sources.find((item) => item.id === third.productUuid)?.slug).toMatch(/^collision-3-[0-9a-f]{8}$/)
    expect(new Set(sources.map((item) => item.slug)).size).toBe(3)
  })
  it.each(['sku', 'ean', 'gtin'] as const)(
    'rejects duplicate %s with a conflict, not missing references',
    async (field) => {
      const first = variant({ ean: '4006381333931', gtin: '4006381333931' })
      await create(draft({ initialVariant: first }))
      const before = rows(),
        next = variant({ sku: 'DIFFERENT-SKU', [field]: first[field] })
      await expect(create(draft({ initialVariant: next }))).rejects.toMatchObject({ code: 'conflict' })
      expect(rows()).toEqual(before)
    }
  )
  it('rejects exhausted IDs without incrementing counters or inserting partial rows', async () => {
    sqlite
      .prepare("UPDATE catalog_draft_legacy_counters SET last_id=? WHERE entity='variant'")
      .run(Number.MAX_SAFE_INTEGER)
    const before = rows()
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
  })
  it('bounds all variants including retired history and never silently hides an overflow', async () => {
    const initial = await create()
    const insert = sqlite.prepare(
      "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES (?,?,?,?,?,?,'Unit','discontinued',0)"
    )
    for (let index = 2; index <= 500; index++)
      insert.run(crypto.randomUUID(), index, initial.productUuid, TAX, SHIPPING, `RETIRED-${index}`)
    const before = rows()
    await expect(add(1, 1)).rejects.toMatchObject({ code: 'variant_limit' })
    expect(rows()).toEqual(before)
    insert.run(crypto.randomUUID(), 501, initial.productUuid, TAX, SHIPPING, 'RETIRED-501')
    await expect(
      execute('assign_brand', { productId: '1' }, { expectedVersion: 1, reason: REASON, brandId: BRAND })
    ).rejects.toMatchObject({ code: 'variant_limit' })
  })
  it.each(['01', '+1', '1.0', '1e0', '1\n', '1\r', ' 1', '1 ', '0', '9007199254740992'])(
    'rejects noncanonical target ID %j before D1 reads',
    async (id) => {
      const prepare = vi.fn(database.prepare.bind(database)),
        db = proxy({ prepare })
      await expect(
        execute('assign_brand', { productId: id }, { expectedVersion: 1, reason: REASON, brandId: BRAND }, { db })
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(prepare).not.toHaveBeenCalled()
    }
  )
  it('checks explicit wrong target/action/options shapes without invoking accessors', async () => {
    await expect(execute('create_draft', { productId: '1' }, draft())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      execute(
        'create_variant',
        { productId: '1', variantId: '2' },
        { expectedVersion: 1, reason: REASON, ...variant() }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    let invoked = false
    const options = {
      get idempotencyKey() {
        invoked = true
        return 'unsafe'
      }
    }
    await expect(
      executeD1CatalogDraftAuthoringCommand(database, CLAIMS, 'create_draft', {}, draft(), options)
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(invoked).toBe(false)
    await expect(
      executeD1CatalogDraftAuthoringCommand(database, CLAIMS, 'create_draft', {}, draft(), { idempotencyKey: 'KEY\n' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('authoritative SQL uses fresh server time while internal test clocks bind only canonical seconds', async () => {
    const queries: string[] = [],
      { db: observed, bound } = captured()
    const db = new Proxy(observed, {
      get(target, key) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
            for (const statement of statements) {
              const sql: unknown = Reflect.get(statement, 'sql'),
                parameters = bound.get(statement)
              if (typeof sql !== 'string' || !parameters) throw new Error('fixture_capture_missing')
              queries.push(sql)
              expect(parameters).toHaveLength(24)
              expect(parameters[0]).toBeNull()
              expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(100000)
              expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%SZ','now')")
            }
            return database.batch<T>(statements)
          }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await create(draft(), { db })
    expect(queries).toHaveLength(9)
    await expect(
      execute('create_draft', {}, draft({ initialVariant: variant({ sku: 'CLOCK-OTHER' }) }), {
        now: utc().replace('Z', '.000Z')
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('creates an isolated draft with zero unapproved price and zero inventory, without a fabricated ledger', async () => {
    const input = draft(),
      before = JSON.stringify(input)
    const receipt = await create(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(receipt).toEqual({
      source: 'cloudflare',
      action: 'create_draft',
      productId: 1,
      productUuid: expect.any(String),
      variantId: 1,
      variantUuid: expect.any(String),
      catalogVersion: 1,
      updated: true
    })
    expect(Object.keys(receipt).join(',')).toBe(
      'source,action,productId,productUuid,variantId,variantUuid,catalogVersion,updated'
    )
    const source = rows()
    expect(source.products[0]).toMatchObject({
      status: 'draft',
      catalog_version: 1,
      brand_id: BRAND,
      category_id: CATEGORY,
      published_at: null
    })
    expect(source.variants[0]).toMatchObject({
      status: 'draft',
      price_gross_cents: 0,
      compare_at_gross_cents: null,
      safety_stock: 0,
      image: null
    })
    expect(source.balances[0]).toMatchObject({
      physical_quantity: 0,
      blocked_quantity: 0,
      version: 1,
      location_id: 'draft-warehouse'
    })
    expect(source.prices).toEqual([])
    expect(source.movements).toEqual([])
    expect(source.commands).toHaveLength(1)
    expect(source.audits).toHaveLength(1)
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_draft_authoring_guards').get()?.total).toBe(0)
  })
  it('adds, edits and explicitly retires a variant without touching omitted variants or mutable identities', async () => {
    const initial = await create(),
      second = await add(initial.productId, 1)
    expect(second.catalogVersion).toBe(2)
    const original = rows().variants.find((row) => row.id === initial.variantUuid)
    const updated = await execute(
      'update_variant',
      { productId: String(initial.productId), variantId: String(second.variantId) },
      {
        expectedVersion: 2,
        reason: REASON,
        format: 'Caja de unidades',
        mpn: 'DRAFT-MPN',
        contentQuantity: 0.5,
        maximumQuantity: 9
      }
    )
    expect(updated.catalogVersion).toBe(3)
    expect(rows().variants.find((row) => row.id === initial.variantUuid)).toEqual(original)
    expect(rows().variants.find((row) => row.id === second.variantUuid)).toMatchObject({
      sku: 'DRAFT-SECOND',
      format: 'Caja de unidades',
      mpn: 'DRAFT-MPN',
      content_quantity: 0.5
    })
    const retired = await execute(
      'discontinue_variant',
      { productId: String(initial.productId), variantId: String(second.variantId) },
      { expectedVersion: 3, reason: REASON }
    )
    expect(retired.catalogVersion).toBe(4)
    expect(rows().variants.find((row) => row.id === second.variantUuid)?.status).toBe('discontinued')
    expect(rows().variants.find((row) => row.id === initial.variantUuid)?.status).toBe('draft')
  })
  it('assigns an explicit existing brand and preserves JSON and identity', async () => {
    const initial = await create(),
      nextBrand = '41000000-0000-4000-8000-000000000038'
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Other brand','other-brand','review')")
      .run(nextBrand)
    sqlite
      .prepare(
        "UPDATE products SET attributes=json_set(attributes,'$.unknown',json('[null,true]')),regulatory=? WHERE id=?"
      )
      .run('{"unknown":null}', initial.productUuid)
    const before = rows().products[0]
    const receipt = await execute(
      'assign_brand',
      { productId: '1' },
      { expectedVersion: 2, reason: REASON, brandId: nextBrand }
    )
    expect(receipt.variantId).toBeNull()
    expect(receipt.variantUuid).toBeNull()
    expect(rows().products[0]).toMatchObject({
      brand_id: nextBrand,
      attributes: before?.attributes,
      regulatory: before?.regulatory,
      slug: before?.slug,
      catalog_version: 3
    })
  })
})

describe('draft authoring strict shared schemas', () => {
  it('accepts explicit zero logistics for an incomplete draft, without optional defaults', () => {
    expect(
      createDraftInputSchema.safeParse(
        draft({ initialVariant: variant({ weightGrams: 0, backorderAllowed: true, leadTimeDays: null }) })
      ).success
    ).toBe(true)
  })
  it.each([
    'price',
    'initialGrossCents',
    'stock',
    'safetyStock',
    'image',
    'active',
    'status',
    'regulatory',
    'sourceId',
    'slug'
  ])('rejects unknown %s input', (field) => {
    expect(createDraftInputSchema.safeParse({ ...draft(), [field]: 1 }).success).toBe(false)
    expect(
      updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON, format: 'Unit', [field]: 1 }).success
    ).toBe(false)
  })
  it.each([
    'name',
    'categoryId',
    'brandId',
    'shortDesc',
    'description',
    'usage',
    'series',
    'featured',
    'badges',
    'visual',
    'attrs',
    'initialVariant'
  ])('requires explicit create %s', (field) => {
    const input: Record<string, unknown> = { ...draft() }
    Reflect.deleteProperty(input, field)
    expect(createDraftInputSchema.safeParse(input).success).toBe(false)
  })
  it.each([
    'sku',
    'format',
    'ean',
    'gtin',
    'mpn',
    'taxClassId',
    'shippingProfileId',
    'unitBase',
    'unitLabel',
    'contentQuantity',
    'unitsPerCase',
    'casesPerPallet',
    'minimumQuantity',
    'quantityIncrement',
    'maximumQuantity',
    'weightGrams',
    'widthMm',
    'heightMm',
    'depthMm',
    'backorderAllowed',
    'leadTimeDays',
    'color'
  ])('requires explicit variant %s', (field) => {
    const input: Record<string, unknown> = { expectedVersion: 1, reason: REASON, ...variant() }
    Reflect.deleteProperty(input, field)
    expect(createVariantInputSchema.safeParse(input).success).toBe(false)
  })
  it('rejects persisted SKU mutation and empty metadata commands', () => {
    expect(updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON, sku: 'NEW-SKU' }).success).toBe(
      false
    )
    expect(updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON }).success).toBe(false)
  })
  it('never invokes getters or coercion and rejects own undefined', () => {
    let invoked = false
    const getter = { ...draft() }
    Object.defineProperty(getter, 'name', {
      enumerable: true,
      get() {
        invoked = true
        return 'Unsafe'
      }
    })
    expect(createDraftInputSchema.safeParse(getter).success).toBe(false)
    expect(invoked).toBe(false)
    expect(updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON, format: undefined }).success).toBe(
      false
    )
    expect(
      assignBrandInputSchema.safeParse({
        expectedVersion: 1,
        reason: REASON,
        brandId: {
          toString() {
            invoked = true
            return BRAND
          }
        }
      }).success
    ).toBe(false)
    expect(invoked).toBe(false)
  })
  it.each(['\n', '\r', '\t', '\0', '\x7f'])('rejects raw controls before trimming %j', (control) => {
    expect(createDraftInputSchema.safeParse(draft({ name: control + 'Valid name' })).success).toBe(false)
    expect(discontinueVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON + control }).success).toBe(
      false
    )
  })
  it('validates supplied identifiers with the existing checksum validator', () => {
    expect(
      createVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON, ...variant({ ean: '4006381333931' }) })
        .success
    ).toBe(true)
    expect(
      createVariantInputSchema.safeParse({ expectedVersion: 1, reason: REASON, ...variant({ gtin: '4006381333932' }) })
        .success
    ).toBe(false)
  })
})
