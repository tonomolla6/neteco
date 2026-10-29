import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleBundlesHttp, ownsBundlesNamespace } from '../../workers/marketing/bundles-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administrador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES ('${ADMIN_ID}', 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO categories (id, name, slug) VALUES ('cat-1', 'Cocinas', 'cocinas');
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('tax-1', 'std', 'IVA 21%', 2100, '${NOW}');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES ('sp-parcel', 'parcel', 'Paquetería', 'parcel');
    INSERT OR IGNORE INTO products (id, category_id, name, slug) VALUES ('p-1', 'cat-1', 'Desengrasante', 'desengrasante');
    INSERT OR IGNORE INTO variants (id, product_id, tax_class_id, shipping_profile_id, sku, format, price_gross_cents)
      VALUES ('v-1', 'p-1', 'tax-1', 'sp-parcel', 'DES-1', '5L', 2500);
    INSERT OR IGNORE INTO variant_price_versions (id, variant_id, gross_cents, status, reason, created_at, valid_from)
      VALUES ('pr-1', 'v-1', 2500, 'approved', 'Precio base', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO inventory_locations (id, code, name, kind, active, created_at)
      VALUES ('loc-1', 'W1', 'Almacén', 'warehouse', 1, '${NOW}');
    INSERT OR IGNORE INTO inventory_balances (variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at)
      VALUES ('v-1', 'loc-1', 10, 0, 1, '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO bundles (id, slug, title, description, sector, task, bundle_price_cents, status, version, created_at, updated_at)
      VALUES ('b0000000-0000-4000-8000-000000000001', 'kit-cocina', 'Kit Limpieza Cocina', 'Kit cocina', 'hosteleria', 'desengrase_profundo', 2000, 'active', 1, '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO bundle_items (id, bundle_id, variant_id, quantity, min_quantity, max_quantity, sort_order)
      VALUES ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'v-1', 1, 1, 5, 0);
  `)

  return sqlite
}

describe('Bundles HTTP Routing & API Contract', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('matches ownsBundlesNamespace correctly', () => {
    expect(ownsBundlesNamespace('/api/bundles')).toBe(true)
    expect(ownsBundlesNamespace('/api/bundles/kit-cocina')).toBe(true)
    expect(ownsBundlesNamespace('/api/admin/bundles')).toBe(true)
    expect(ownsBundlesNamespace('/api/other')).toBe(false)
  })

  it('GET /api/bundles lists public active bundles with stock and savings', async () => {
    const req = new Request('https://tienda.neteco.test/api/bundles?sector=hosteleria')
    const res = await handleBundlesHttp(req, { database: db, now: NOW })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items).toHaveLength(1)
    expect(data.items[0].slug).toBe('kit-cocina')
    expect(data.items[0].bundlePriceCents).toBe(2000)
    expect(data.items[0].equivalentStandaloneCents).toBe(2500)
    expect(data.items[0].savingsCents).toBe(500)
    expect(data.items[0].maxAvailableKits).toBe(10)
  })

  it('GET /api/bundles/:slug returns single bundle with component details', async () => {
    const req = new Request('https://tienda.neteco.test/api/bundles/kit-cocina')
    const res = await handleBundlesHttp(req, { database: db, now: NOW })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.bundle.slug).toBe('kit-cocina')
    expect(data.bundle.items).toHaveLength(1)
    expect(data.bundle.items[0].variantSku).toBe('DES-1')
  })

  it('POST /api/bundles/calculate recalculates dynamic selection', async () => {
    const req = new Request('https://tienda.neteco.test/api/bundles/calculate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bundleId: 'b0000000-0000-4000-8000-000000000001',
        kitQuantity: 2,
        customQuantities: {
          'v-1': 3
        }
      })
    })

    const res = await handleBundlesHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.selection.equivalentStandaloneCents).toBe(15000) // 2 kits * (3 * 2500)
    expect(data.selection.bundlePriceCents).toBeLessThan(15000)
    expect(data.selection.savingsCents).toBeGreaterThan(0)
  })

  it('POST /api/admin/bundles requires administrative authorization', async () => {
    const req = new Request('https://tienda.neteco.test/api/admin/bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'b0000000-0000-4000-8000-000000000002',
        idempotencyKey: 'idem-no-auth',
        title: 'Kit No Auth',
        slug: 'kit-no-auth',
        description: 'Test',
        sector: 'general',
        task: 'limpieza_general',
        bundlePriceCents: 2000,
        items: [{ variantId: 'v-1', quantity: 1, minQuantity: 1, maxQuantity: 5 }]
      })
    })

    const res = await handleBundlesHttp(req, { database: db, now: NOW })
    expect(res.status).toBe(401)
  })
})
