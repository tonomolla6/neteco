import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { executeD1OrderAnnotations, readD1OrderAnnotations } from '../../workers/catalog/order-annotations'
import { executeD1CompanyReview } from '../../workers/auth/admin-companies'
import {
  requestNewsletterConsent,
  confirmNewsletterConsent,
  isNewsletterSendEligible
} from '../../workers/marketing/newsletter'
import {
  readD1AccountPreferences,
  updateD1AccountPreferences,
  readD1AccountPreferenceCommand
} from '../../workers/auth/account-preferences'
import { readD1AccountPrivacy, executeD1AccountPrivacy } from '../../workers/auth/account-privacy'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { NEWSLETTER_POLICY_VERSION, NEWSLETTER_CONSENT_TEXT } from '../../shared/newsletter'
import { preferenceSeeds, CLAIMS, ACTOR, CUSTOMER, KEY, OPTIONS, BEFORE } from './d1-account-preferences-fixture'
import { deterministicUuid } from '../fixtures/deterministic'

// New verification of existing migrations, not an invented production RED.
// Real SQL + existing splitter/adapters/services; no alternate schema/runner,
// down migrations, fabricated payment authority, network or provider calls.
const directory = new URL('../../db/d1/migrations/', import.meta.url)
let migrations: Array<{ name: string; statements: string[] }>
beforeAll(async () => {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  expect(names).toContain('0083_admin_bootstrap.sql')
  expect(names).toContain('0084_admin_audit.sql')
  expect(names).toContain('0085_admin_order_views.sql')
  expect(names).toContain('0086_admin_order_bulk.sql')
  expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: names.length }, (_, i) => i + 1))
  migrations = await Promise.all(
    names.map(async (name) => ({ name, statements: splitDemoSql(await readFile(new URL(name, directory), 'utf8')) }))
  )
})
async function apply(db: D1Database, from = 0, through = migrations.length) {
  for (const migration of migrations.slice(from, through)) {
    const result = await db.batch(migration.statements.map((sql) => db.prepare(sql)))
    expect(
      result.every((item) => item.success === true),
      migration.name
    ).toBe(true)
  }
}
function sqliteDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  // Actual D1 query limits; historical color data are explicitly loaded before
  // reducing LIKE/GLOB to 50 in the one pre-repair legacy fixture below.
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  sqlite.limits.likePatternLength = 50
  return sqlite
}
const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"'
function existingData(sqlite: DatabaseSync) {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  return tables.map(({ name }) => {
    const columns = (sqlite.prepare('PRAGMA table_info(' + ident(name) + ')').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    const query = `SELECT ${columns.map(ident).join(',')} FROM ${ident(name)} ORDER BY ${columns.map(ident).join(',')}`
    return { query, rows: sqlite.prepare(query).all() }
  })
}
function preserved(sqlite: DatabaseSync, before: ReturnType<typeof existingData>) {
  for (const table of before) expect(sqlite.prepare(table.query).all(), table.query).toEqual(table.rows)
  expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(sqlite.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
}
async function assertLatest(db: D1Database) {
  const names = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN('order_annotation_commands','company_admin_review_commands','account_privacy_requests','account_preference_commands','customer_account_preferences','inventory_alert_commands','inventory_alert_episodes','support_satisfaction_commands','support_satisfaction_feedback','order_packing_commands','order_packings','order_packing_audit','delivery_preference_commands','delivery_preferences','operational_email_suppressions','admin_order_bulk_attempts','admin_order_bulk_groups','admin_order_bulk_guards','admin_order_bulk_pauses','admin_order_bulk_results') ORDER BY name"
    )
    .all()
  expect(names.results).toEqual(
    [
      'account_preference_commands',
      'account_privacy_requests',
      'admin_order_bulk_attempts',
      'admin_order_bulk_groups',
      'admin_order_bulk_guards',
      'admin_order_bulk_pauses',
      'admin_order_bulk_results',
      'company_admin_review_commands',
      'customer_account_preferences',
      'delivery_preference_commands',
      'delivery_preferences',
      'inventory_alert_commands',
      'inventory_alert_episodes',
      'operational_email_suppressions',
      'order_annotation_commands',
      'order_packing_audit',
      'order_packing_commands',
      'order_packings',
      'support_satisfaction_commands',
      'support_satisfaction_feedback'
    ].map((name) => ({ name }))
  )
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
}
const secrets = { hmacKey: new Uint8Array(32).fill(73) }
async function accountBaseline(db: D1Database) {
  await db.batch(preferenceSeeds().map((sql) => db.prepare(sql)))
  const company = deterministicUuid('migration-preserved-company'),
    change = deterministicUuid('migration-preserved-submission')
  await db.batch([
    db
      .prepare(
        "INSERT INTO companies(id,customer_id,legal_name,tax_id,country_code,status,created_at,updated_at,last_change_id) VALUES(?,?,'Empresa sintética','B12345674','ES','pending',?,?,?)"
      )
      .bind(company, CUSTOMER, BEFORE, BEFORE, change),
    db
      .prepare(
        "INSERT INTO company_review_events(id,company_id,actor_identity_id,event_type,tax_id_suffix,created_at) VALUES(?,?,?,'submitted','5674',?)"
      )
      .bind(change, company, ACTOR, BEFORE)
  ])
  const consent = await requestNewsletterConsent(
    db,
    {
      email: 'preferences@example.invalid',
      purpose: 'newsletter',
      consentText: NEWSLETTER_CONSENT_TEXT,
      consentVersion: NEWSLETTER_POLICY_VERSION,
      consentSource: 'account_preferences',
      idempotencyKey: 'upgrade-newsletter-consent',
      now: Date.parse(BEFORE) / 1000
    },
    secrets
  )
  expect(consent.internalDelivery).not.toBeNull()
  await confirmNewsletterConsent(
    db,
    consent.internalDelivery!.confirmationToken,
    secrets,
    Date.parse(BEFORE) / 1000 + 1
  )
}
async function assertUpgradedAccount(db: D1Database) {
  // Existing DOI remains valid and immutable; no upgrade generates a new opt-in.
  expect(await isNewsletterSendEligible(db, 'preferences@example.invalid', secrets)).toBe(true)
  await expect(db.prepare("DELETE FROM newsletter_consent_events WHERE event_type='confirmed'").run()).rejects.toThrow(
    /immutable/
  )
  expect(await readD1AccountPreferences(db, CLAIMS, OPTIONS)).toMatchObject({
    version: 0,
    updatedAt: null,
    preferences: { product_updates: false, replenishment: false }
  })
  const input = {
    expectedVersion: 0,
    policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
    preferences: { product_updates: true, replenishment: false }
  }
  // 0064's guard is checked against an EXISTING company/current customer
  // session, so foreign keys alone cannot accidentally make this assertion pass.
  await expect(
    db
      .prepare(
        `INSERT INTO company_admin_review_commands(command_id,company_id,actor_id,session_id,session_version,payload_hash,expected_change_id,from_status,to_status,reason,tax_id_suffix,created_at)
   VALUES(?,?,?,?,1,?,?,'pending','approved','Synthetic unauthorized review','5674',?)`
      )
      .bind(
        deterministicUuid('upgrade-forbidden-review'),
        deterministicUuid('migration-preserved-company'),
        ACTOR,
        CLAIMS.sessionId,
        'a'.repeat(64),
        deterministicUuid('migration-preserved-submission'),
        OPTIONS.now()
      )
      .run()
  ).rejects.toThrow(/company_review_conflict/)
  expect(await db.prepare('SELECT count(*) n FROM company_admin_review_commands').first()).toEqual({ n: 0 })
  const receipt = await updateD1AccountPreferences(db, CLAIMS, KEY, input, OPTIONS)
  expect(await readD1AccountPreferenceCommand(db, CLAIMS, KEY, OPTIONS)).toMatchObject({ outcome: 'applied', receipt })
  await expect(
    updateD1AccountPreferences(db, CLAIMS, deterministicUuid('migration-stale-command'), input, OPTIONS)
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(db.prepare('DELETE FROM account_preference_commands').run()).rejects.toThrow(/immutable/)
  await expect(db.prepare('UPDATE customer_account_preferences SET replenishment=2').run()).rejects.toThrow()
  expect(await readD1AccountPrivacy(db, CLAIMS, OPTIONS)).toMatchObject({ source: 'cloudflare', requests: [] })
  expect(
    await executeD1AccountPrivacy(
      db,
      CLAIMS,
      { requestType: 'anonymize', idempotencyKey: deterministicUuid('migration-privacy-request') },
      OPTIONS
    )
  ).toMatchObject({ requestType: 'anonymize', status: 'requested', completedAt: null })
  await expect(db.prepare('DELETE FROM account_privacy_requests').run()).rejects.toThrow(/immutable/)
  const foreignCustomer = deterministicUuid('migration-foreign-customer'),
    foreignActor = deterministicUuid('migration-foreign-actor'),
    foreignSession = deterministicUuid('migration-foreign-session')
  await db.batch([
    db.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').bind(foreignCustomer, BEFORE, BEFORE),
    db
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,'foreign@example.invalid','synthetic','active',?,?,?,?)"
      )
      .bind(foreignActor, BEFORE, foreignCustomer, BEFORE, BEFORE),
    db
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,'2099-01-01T00:00:00Z')"
      )
      .bind(foreignSession, foreignActor, BEFORE)
  ])
  const foreignClaims = { identityId: foreignActor, sessionId: foreignSession, sessionVersion: 1 }
  expect(await readD1AccountPreferences(db, foreignClaims, OPTIONS)).toMatchObject({ version: 0 })
  expect(await readD1AccountPreferenceCommand(db, foreignClaims, KEY, OPTIONS)).toMatchObject({
    outcome: 'unknown',
    receipt: null
  })
  expect(await readD1AccountPrivacy(db, foreignClaims, OPTIONS)).toMatchObject({ requests: [] })
  await expect(readD1AccountPreferences(db, { ...CLAIMS, sessionId: foreignSession }, OPTIONS)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
}

it('applies the complete current chain to empty SQLite with D1 limits and valid foreign keys', async () => {
  const sqlite = sqliteDatabase()
  try {
    const db = d1OverSqlite(sqlite)
    await apply(db)
    await assertLatest(db)
    preserved(sqlite, [])
  } finally {
    sqlite.close()
  }
})
it('upgrades populated 0055 through current preserving historical colors, quotes, governed prices, stock and every original field', async () => {
  const sqlite = sqliteDatabase(),
    db = d1OverSqlite(sqlite)
  try {
    await apply(db, 0, 55)
    await accountBaseline(db)
    const world = seedInventoryFixture(sqlite)
    sqlite.limits.likePatternLength = 50000 // A legacy stored value, before D1's historical failing CHECK.
    sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#aBc123', world.variantId(1, 1))
    await provisionPublicationValidityFixture(db, { productIds: ['p-1', 'p-2'], now: BEFORE })
    sqlite
      .prepare(
        "INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at) VALUES('upgrade-price',?,300,?,'approved','Synthetic migration fixture',?)"
      )
      .run(world.variantId(1, 1), BEFORE, BEFORE)
    const cart = await createCart(db, { correlationId: 'upgrade-cart', now: OPTIONS.now() })
    expect(
      await setCartLine(db, {
        ...cart,
        idempotencyKey: 'upgrade-add',
        expectedVersion: 1,
        variantId: world.variantId(1, 1),
        quantity: 2,
        mode: 'add',
        correlationId: 'upgrade-cart',
        now: OPTIONS.now()
      })
    ).toMatchObject({ outcome: 'applied' })
    const quote = await quoteCart(db, {
      ...cart,
      idempotencyKey: 'upgrade-quote',
      expectedVersion: 2,
      correlationId: 'upgrade-cart',
      now: OPTIONS.now()
    })
    if (quote.outcome !== 'quoted') throw new Error('synthetic_upgrade_quote_unconfirmed')
    sqlite
      .prepare(
        "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('upgrade-pickup-zone','upgrade-pickup','Synthetic pickup','warehouse_pickup','[]',1,?)"
      )
      .run(BEFORE)
    sqlite
      .prepare(
        "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('upgrade-pickup-rate','upgrade-pickup-zone','pickup','parcel',0,2100,0,0,1,1,?)"
      )
      .run(BEFORE)
    const shipping = await requestShippingOptions(db, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'upgrade-shipping',
      correlationId: 'upgrade-cart',
      now: OPTIONS.now(),
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error('synthetic_upgrade_shipping_unconfirmed')
    const option = (
      shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    ).find((o) => o.methodCode === 'pickup')!
    const order = await placeOrder(db, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'upgrade-checkout',
      correlationId: 'upgrade-cart',
      now: OPTIONS.now(),
      ownerSession: CLAIMS,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'preferences@example.invalid',
      contactName: 'Cliente sintético',
      contactPhone: '+34600111222',
      shippingAddress: {
        recipientName: 'Cliente sintético',
        line1: 'Calle sintética 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '+34600111222'
      },
      consentTos: true,
      consentPrivacy: true
    })
    if (order.outcome !== 'order_created') throw new Error('synthetic_upgrade_checkout_unconfirmed')
    const orderId = String(order.body.id)
    const before = existingData(sqlite)
    sqlite.limits.likePatternLength = 50
    // Existing historical defect, not a fabricated RED: D1 rejects a valid color before 0056.
    expect(() =>
      sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#ffffff', world.variantId(1, 1))
    ).toThrow(/pattern too complex/)
    await apply(db, 55)
    preserved(sqlite, before)
    await assertLatest(db)
    expect(sqlite.prepare('SELECT color FROM variants WHERE id=?').get(world.variantId(1, 1))).toEqual({
      color: '#aBc123'
    })
    expect(() => sqlite.exec('UPDATE checkout_quotes SET total_gross_cents=0')).toThrow(/immutable/)
    expect(() => sqlite.prepare('UPDATE cart_lines SET quantity=0 WHERE cart_id=?').run(cart.cartId)).toThrow(/CHECK/)
    expect(() =>
      sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#HH0000', world.variantId(1, 1))
    ).toThrow(/CHECK/)
    sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#ffffff', world.variantId(1, 1))
    expect(
      sqlite.prepare("SELECT name FROM sqlite_schema WHERE name='catalog_color_migration_0056_backup'").get()
    ).toBeUndefined()
    // Exercise 0063–0064 after upgrade using the historical REAL unpaid checkout,
    // not a seeded financial order. Review grants are synthetic local fixtures.
    await assertUpgradedAccount(db)
    await expect(readD1OrderAnnotations(db, CLAIMS, orderId, {}, OPTIONS)).rejects.toMatchObject({
      code: 'mfa_required'
    })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(CLAIMS.sessionId)
    sqlite.exec(
      "INSERT OR IGNORE INTO roles VALUES('migration-reviewer','Migration reviewer','Synthetic');INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic');INSERT INTO role_permissions VALUES('migration-reviewer','administration.manage')"
    )
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'migration-reviewer',?)")
      .run(ACTOR, BEFORE)
    const commandId = deterministicUuid('upgrade-order-note'),
      note = { expectedVersion: 0, note: 'Synthetic private migration note', labels: ['migration-check'] }
    const annotation = await executeD1OrderAnnotations(db, CLAIMS, orderId, commandId, note, OPTIONS)
    expect(await executeD1OrderAnnotations(db, CLAIMS, orderId, commandId, note, OPTIONS)).toEqual(annotation)
    expect(await readD1OrderAnnotations(db, CLAIMS, orderId, {}, OPTIONS)).toMatchObject({
      version: 1,
      labels: ['migration-check'],
      notes: [{ text: note.note }]
    })
    expect(() => sqlite.exec('DELETE FROM order_annotation_commands')).toThrow(/immutable/)
    expect(
      await executeD1CompanyReview(
        db,
        CLAIMS,
        deterministicUuid('migration-preserved-company'),
        deterministicUuid('upgrade-authorized-review'),
        {
          expectedChangeId: deterministicUuid('migration-preserved-submission'),
          expectedStatus: 'pending',
          status: 'approved',
          reason: 'Synthetic administrative migration review'
        },
        OPTIONS
      )
    ).toMatchObject({ status: 'approved' })
    sqlite.prepare("DELETE FROM identity_roles WHERE identity_id=? AND role_code='migration-reviewer'").run(ACTOR)
    await expect(readD1OrderAnnotations(db, CLAIMS, orderId, {}, OPTIONS)).rejects.toMatchObject({ code: 'forbidden' })
  } finally {
    sqlite.close()
  }
})
it('upgrades populated 0062 to current without rewriting owner/session/company/newsletter evidence and enforces new authority', async () => {
  const sqlite = sqliteDatabase(),
    db = d1OverSqlite(sqlite)
  try {
    await apply(db, 0, 62)
    await accountBaseline(db)
    const before = existingData(sqlite)
    await apply(db, 62)
    preserved(sqlite, before)
    await assertUpgradedAccount(db)
    preserved(sqlite, [])
  } finally {
    sqlite.close()
  }
})

async function withNative(body: (db: D1Database) => Promise<void>) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'migration-upgrade-native',
      modules: true,
      script: 'export default{fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000006610' },
      outboundService: () => {
        throw new Error('unexpected_outbound')
      }
    })
  )
  try {
    await body((await runtime.getD1Database('DB')) as unknown as D1Database)
  } finally {
    await runtime.dispose()
  }
}
const baselineQueries = [
  'SELECT * FROM customers ORDER BY id',
  'SELECT * FROM identities ORDER BY id',
  'SELECT * FROM auth_sessions ORDER BY id',
  'SELECT * FROM companies ORDER BY id',
  'SELECT * FROM company_review_events ORDER BY id',
  'SELECT * FROM newsletter_subscriptions ORDER BY id',
  'SELECT * FROM newsletter_consent_events ORDER BY id'
]
async function nativeData(db: D1Database) {
  return (await db.batch(baselineQueries.map((sql) => db.prepare(sql)))).map((r) => r.results)
}
it('applies all current real migrations on workerd D1 from an empty database', async () => {
  await withNative(async (db) => {
    await apply(db)
    await assertLatest(db)
    // D1 rejects PRAGMA integrity_check with SQLITE_AUTH. SQLite above checks
    // physical integrity; D1 here verifies all real statements and FK integrity.
  })
}, 30000)
it('upgrades a populated 0062 D1 baseline to current preserving actual consent and enforcing owner isolation/CAS', async () => {
  await withNative(async (db) => {
    await apply(db, 0, 62)
    await accountBaseline(db)
    const before = await nativeData(db)
    await apply(db, 62)
    expect(await nativeData(db)).toEqual(before)
    await assertLatest(db)
    await assertUpgradedAccount(db)
  })
}, 30000)
it.each(['SQLite', 'workerd D1'] as const)(
  'rolls back a failed 0066 batch on %s and retries the unchanged forward migration without losing baseline data',
  async (engine) => {
    const check = async (db: D1Database) => {
      await apply(db, 0, 65)
      await accountBaseline(db)
      const before = await nativeData(db),
        schema = await db
          .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
          .all()
      // Fault at the end of the real migration: every preceding DDL/trigger must
      // roll back, while the already-applied baseline remains intact.
      await expect(
        db.batch([
          ...migrations[65]!.statements.map((sql) => db.prepare(sql)),
          db.prepare('INSERT INTO migration_intentionally_missing_table VALUES(1)')
        ])
      ).rejects.toThrow()
      expect(
        (
          await db
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
            )
            .all()
        ).results
      ).toEqual(schema.results)
      expect(await nativeData(db)).toEqual(before)
      await apply(db, 65)
      await assertLatest(db)
      expect(await nativeData(db)).toEqual(before)
      await assertUpgradedAccount(db)
    }
    if (engine === 'workerd D1') await withNative(check)
    else {
      const sqlite = sqliteDatabase()
      try {
        await check(d1OverSqlite(sqlite))
        preserved(sqlite, [])
      } finally {
        sqlite.close()
      }
    }
  },
  30000
)
