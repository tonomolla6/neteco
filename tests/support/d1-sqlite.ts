import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = [
  '0001_platform.sql',
  '0002_catalog_read_model.sql',
  '0003_variant_price_versions.sql',
  '0004_inventory_operations.sql',
  '0005_cart_checkout.sql',
  '0006_checkout_orders.sql'
].map((name) => fileURLToPath(new URL(`../../db/d1/migrations/${name}`, import.meta.url)))

export async function openMigratedDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of MIGRATIONS) database.exec(await readFile(path, 'utf8'))
  return database
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
  let parameters: unknown[] = []
  const execute = <T>(mode: 'all' | 'get'): T | { results: T[] } => {
    const prepared = database.prepare(sql)
    return mode === 'all'
      ? ({ results: prepared.all(...parameters) as T[] } as { results: T[] })
      : ((prepared.get(...parameters) as T | undefined) ?? null)
  }
  const statement: D1StatementLike = {
    sql,
    bind(...next: unknown[]) {
      parameters = next
      return statement
    },
    async first(...next: unknown[]) {
      if (next.length) parameters = next
      return (await execute('get')) as never
    },
    async all(...next: unknown[]) {
      if (next.length) parameters = next
      return (await execute('all')) as never
    },
    async run(...next: unknown[]) {
      if (next.length) parameters = next
      database.prepare(sql).run(...parameters)
      return { success: true }
    }
  }
  return statement
}

/** Minimal D1Database adapter over node:sqlite so worker code runs against real SQLite. */
export function d1OverSqlite(sqliteDatabase: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => makeStatement(sqliteDatabase, sql),
    batch: async (statements: D1StatementLike[]) => {
      sqliteDatabase.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const statement of statements) {
          results.push(await statement.all())
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
    }
  } as unknown as D1Database
}

export interface InventoryWorld {
  locationId: string
  variantId: (productIndex: number, variantIndex: number) => string
  quantityOf: (productIndex: number, variantIndex: number) => number
}

/** Minimal catalog + inventory fixture aligned with the deterministic seeds. */
export function seedInventoryFixture(database: DatabaseSync): InventoryWorld {
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
    const physical = productIndex === 4 ? 3 : 25
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
