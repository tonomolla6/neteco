import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = [
  '0001_platform.sql',
  '0002_catalog_read_model.sql',
  '0003_variant_price_versions.sql',
  '0004_inventory_operations.sql',
  '0005_cart_checkout.sql',
  '0006_checkout_orders.sql',
  '0007_payments.sql',
  '0008_payment_fulfilment_claims.sql',
  '0009_fiscal_outbox.sql',
  '0010_fiscal_evaluation_inbox.sql',
  '0011_fiscal_delivery_reconciliation.sql',
  '0012_media_quarantine.sql',
  '0013_media_storage_reconciliation.sql',
  '0014_identity_authorization.sql',
  '0015_identity_rate_limits.sql',
  '0016_mfa_challenges.sql',
  '0017_authentication_rate_limits.sql',
  '0018_customer_profiles.sql',
  '0019_company_review_events.sql',
  '0020_customer_addresses.sql',
  '0021_account_security.sql',
  '0022_mfa_enrollments.sql',
  '0023_price_window_precision.sql',
  '0024_newsletter_consent.sql',
  '0025_order_customer_ownership.sql',
  '0026_customer_favorites.sql',
  '0027_email_outbox.sql',
  '0028_order_contact_contract.sql',
  '0029_order_access_lifecycle.sql',
  '0030_newsletter_confirmation_delivery.sql',
  '0031_transactional_email_delivery.sql',
  '0032_identity_lifecycle.sql',
  '0033_media_publication.sql',
  '0034_catalog_draft_metadata.sql',
  '0035_catalog_product_status.sql',
  '0036_catalog_publication_policy.sql',
  '0037_catalog_policy_commands.sql',
  '0038_catalog_draft_authoring.sql',
  '0039_catalog_price_commands.sql',
  '0040_catalog_category_commands.sql',
  '0041_admin_inventory_commands.sql',
  '0042_fiscal_issuance.sql',
  '0043_order_fulfillment.sql',
  '0044_cms_draft_commands.sql',
  '0045_cms_publication.sql',
  '0046_order_returns.sql',
  '0047_fiscal_runtime_email_manifest.sql',
  '0048_order_refunds_credit_notes.sql',
  '0049_support_operations.sql',
  '0050_newsletter_editorial.sql',
  '0051_newsletter_local_validation.sql',
  '0052_analytics_measurement.sql',
  '0053_catalog_editorial_import.sql',
  '0054_catalog_native_import.sql',
  '0055_catalog_import_jobs.sql',
  '0056_catalog_color_pattern.sql',
  '0057_catalog_import_job_commands.sql',
  '0058_catalog_typed_attributes.sql',
  '0059_catalog_typed_attribute_values.sql',
  '0060_support_macros.sql',
  '0061_search_synonyms.sql',
  '0062_support_knowledge_feedback.sql',
  '0091_search_merchandising_rules.sql'
].map((name) => fileURLToPath(new URL(`../../db/d1/migrations/${name}`, import.meta.url)))
/** Base migrations applied by openMigratedDatabase; later suites must not apply them twice. */
export const BASE_MIGRATION_NAMES: ReadonlySet<string> = new Set(MIGRATIONS.map((path) => path.split('/').pop()!))

// Cache immutable SQL source per test worker, never a database or its rows.
// Promise.all retains migration order and concurrent fixtures share the reads.
let migrationSources: Promise<string[]> | undefined

export async function openMigratedDatabase() {
  const sources = await (migrationSources ??= Promise.all(MIGRATIONS.map((path) => readFile(path, 'utf8'))))
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const source of sources) database.exec(source)
  return database
}

/** Explicit current-security fixture; preserve the historical 0062 baseline. */
export async function openAccountSecurityDatabase() {
  const { splitDemoSql } = await import('../../scripts/lib/d1-demo-sql')
  const database = await openMigratedDatabase()
  try {
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    const files = (await readdir(directory))
      .filter(
        (file) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && !BASE_MIGRATION_NAMES.has(file)
      )
      .sort()
    const adapter = d1OverSqlite(database)
    for (const file of files) {
      await adapter.batch(
        splitDemoSql(await readFile(new URL(file, directory), 'utf8')).map((sql) => adapter.prepare(sql))
      )
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function applyGeneratedSeed(database: DatabaseSync, sql: string) {
  database.exec(sql)
}

export interface D1StatementLike {
  sql: string
  bind(...parameters: unknown[]): D1StatementLike
  first(...parameters: unknown[]): Promise<unknown>
  all(...parameters: unknown[]): Promise<{ results: unknown[] }>
  run(...parameters: unknown[]): Promise<{ success: true }>
}

/** Closure-based statement: safe to spread/destructure in test wrappers. */
function makeStatement(database: DatabaseSync, sql: string): D1StatementLike {
  // Preserve caller values: node:sqlite itself validates binding types. Do not
  // coerce malformed values in this adapter and conceal a Worker regression.
  let parameters: SQLInputValue[] = []
  const execute = <T>(mode: 'all' | 'get'): T | null | { results: T[] } => {
    const prepared = database.prepare(sql)
    return mode === 'all'
      ? ({ results: prepared.all(...parameters) as T[] } as { results: T[] })
      : ((prepared.get(...parameters) as T | undefined) ?? null)
  }
  const statement: D1StatementLike = {
    sql,
    bind(...next: unknown[]) {
      parameters = next as SQLInputValue[]
      return statement
    },
    async first(...next: unknown[]) {
      if (next.length) parameters = next as SQLInputValue[]
      return (await execute('get')) as never
    },
    async all(...next: unknown[]) {
      if (next.length) parameters = next as SQLInputValue[]
      return { ...(await execute<{ results: unknown[] }>('all')), success: true } as never
    },
    async run(...next: unknown[]) {
      if (next.length) parameters = next as SQLInputValue[]
      database.prepare(sql).run(...parameters)
      return { success: true }
    }
  }
  return statement
}

// D1 admits one transaction at a time per database. Multiple adapters may wrap
// one SQLite connection, so admission belongs to that connection, not a facade.
const batchAdmission = new WeakMap<DatabaseSync, Promise<void>>()

/** Minimal D1Database adapter over node:sqlite so worker code runs against real SQLite. */
export function d1OverSqlite(sqliteDatabase: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => makeStatement(sqliteDatabase, sql),
    batch: async (statements: D1StatementLike[]) => {
      const predecessor = batchAdmission.get(sqliteDatabase) ?? Promise.resolve()
      let release!: () => void
      const admitted = new Promise<void>((resolve) => {
        release = resolve
      })
      batchAdmission.set(sqliteDatabase, admitted)
      await predecessor
      try {
        sqliteDatabase.exec('BEGIN IMMEDIATE')
        try {
          const results = []
          for (const statement of statements) {
            // A successful D1 batch includes the platform success flag for every
            // statement; callers must not have to accept incomplete fake results.
            results.push({ ...(await statement.all()), success: true })
          }
          sqliteDatabase.exec('COMMIT')
          return results
        } catch (error) {
          try {
            sqliteDatabase.exec('ROLLBACK')
          } catch {
            // already rolled back by the engine
          }
          throw error
        }
      } finally {
        release()
        if (batchAdmission.get(sqliteDatabase) === admitted) batchAdmission.delete(sqliteDatabase)
      }
    }
  } as unknown as D1Database
}

export interface InventoryWorld {
  locationId: string
  variantId: (productIndex: number, variantIndex: number) => string
  quantityOf: (productIndex: number, variantIndex: number) => number
}

/** Minimal catalog + inventory fixture aligned with the deterministic seeds. */
export function seedInventoryFixture(
  database: DatabaseSync,
  options: { initialPhysicalQuantity?: number } = {}
): InventoryWorld {
  database.exec("INSERT INTO brands (id, name, slug, status) VALUES ('b1', 'NETECO', 'neteco', 'published')")
  database.exec(
    "INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('t21', 'ES-GEN-21', 'General 21 %', 2100, '2020-01-01T00:00:00Z')"
  )
  database.exec("INSERT INTO shipping_profiles (id, code, name, kind) VALUES ('sp1', 'parcel', 'Parcel', 'parcel')")
  database.exec(
    "INSERT INTO categories (id, legacy_id, name, slug, status, sort_order) VALUES ('c1', 7, 'Químicos', 'quimicos', 'published', 7)"
  )

  const locationId = 'loc-main'
  database.exec(
    `INSERT INTO inventory_locations (id, code, name, kind, active, created_at)
     VALUES ('${locationId}', 'ALM-TEST', 'Almacén test', 'warehouse', 1, '2026-08-12T00:00:00Z')`
  )

  const variantId = (productIndex: number, variantIndex: number) => `v-${productIndex}-${variantIndex}`
  for (const [productIndex, variantIndex] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
    [5, 1],
    [6, 1]
  ] as const) {
    database
      .prepare(
        `INSERT INTO products (id, legacy_id, category_id, name, slug, status)
         VALUES (?, ?, 'c1', ?, ?, 'published')`
      )
      .run(`p-${productIndex}`, productIndex, `Producto ${productIndex}`, `producto-${productIndex}`)
    database
      .prepare(
        `INSERT INTO variants (
           id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
           price_gross_cents, backorder_allowed, safety_stock
         ) VALUES (?, ?, ?, 't21', 'sp1', ?, 'Botella 1 L', 'published', 500, ?, ?)`
      )
      .run(
        variantId(productIndex, variantIndex),
        productIndex * 10 + variantIndex,
        `p-${productIndex}`,
        `SKU-${productIndex}-${variantIndex}`,
        productIndex === 5 ? 1 : 0,
        productIndex % 3
      )
    const physical = productIndex === 4 ? 3 : (options.initialPhysicalQuantity ?? 25)
    database
      .prepare(
        `INSERT INTO inventory_balances (
           variant_id, location_id, physical_quantity, blocked_quantity,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 1, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')`
      )
      .run(variantId(productIndex, variantIndex), locationId, physical)
    database
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, idempotency_key, correlation_id, reason, created_at
         ) VALUES (?, ?, ?, 'initial', ?, 0, 'seed', ?, 'fixture', 'Saldo inicial', '2026-08-12T00:00:00Z')`
      )
      .run(
        `mv-${productIndex}-${variantIndex}`,
        variantId(productIndex, variantIndex),
        locationId,
        physical,
        `mv-${productIndex}-${variantIndex}`
      )
  }

  return {
    locationId,
    quantityOf: () => 0,
    variantId
  }
}
