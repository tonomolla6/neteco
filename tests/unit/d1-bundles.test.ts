import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { calculateBundleAvailability, calculateBundlePricing } from '../../shared/bundles'
import {
  BundleError,
  createD1Bundle,
  getD1BundleBySlug,
  listD1Bundles,
  updateD1Bundle,
  archiveD1Bundle,
  calculateD1BundleSelection
} from '../../workers/marketing/bundles'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

const CATEGORY_ID = 'cat-cocina-01'
const PRODUCT_ID_1 = 'prod-desengrasante-01'
const VARIANT_ID_1 = 'var-desengrasante-5l'
const PRODUCT_ID_2 = 'prod-desinfectante-01'
const VARIANT_ID_2 = 'var-desinfectante-5l'
const TAX_CLASS_ID = 'tax-standard-21'
const LOCATION_ID = 'loc-main-warehouse'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)

  // Roles & permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@neteco.test', 'fixture-hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  // Fixtures: categories, tax classes, shipping profiles, products, variants, price versions, inventory
  sqlite.exec(`
    INSERT OR IGNORE INTO categories (id, name, slug) VALUES ('${CATEGORY_ID}', 'Cocinas', 'cocinas');
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('${TAX_CLASS_ID}', 'std', 'IVA 21%', 2100, '${NOW}');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES ('sp-parcel', 'parcel', 'Paquetería', 'parcel');

    INSERT OR IGNORE INTO products (id, category_id, name, slug) VALUES
      ('${PRODUCT_ID_1}', '${CATEGORY_ID}', 'Desengrasante Profesional Alcalino', 'desengrasante-profesional'),
      ('${PRODUCT_ID_2}', '${CATEGORY_ID}', 'Desinfectante de Superficies Alimentarias', 'desinfectante-alimentario');
      
    INSERT OR IGNORE INTO variants (id, product_id, tax_class_id, shipping_profile_id, sku, format, price_gross_cents) VALUES
      ('${VARIANT_ID_1}', '${PRODUCT_ID_1}', '${TAX_CLASS_ID}', 'sp-parcel', 'DESENG-5L', 'Garrafa 5L', 2500),
      ('${VARIANT_ID_2}', '${PRODUCT_ID_2}', '${TAX_CLASS_ID}', 'sp-parcel', 'DESINF-5L', 'Garrafa 5L', 2000);

    INSERT OR IGNORE INTO variant_price_versions (id, variant_id, gross_cents, status, reason, created_at, valid_from) VALUES
      ('price-1', '${VARIANT_ID_1}', 2500, 'approved', 'Precio base', '${NOW}', '${NOW}'),
      ('price-2', '${VARIANT_ID_2}', 2000, 'approved', 'Precio base', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO inventory_locations (id, code, name, kind, active, created_at) VALUES
      ('${LOCATION_ID}', 'WH1', 'Almacén Central', 'warehouse', 1, '${NOW}');

    INSERT OR IGNORE INTO inventory_balances (variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at) VALUES
      ('${VARIANT_ID_1}', '${LOCATION_ID}', 20, 2, 1, '${NOW}', '${NOW}'),
      ('${VARIANT_ID_2}', '${LOCATION_ID}', 15, 0, 1, '${NOW}', '${NOW}');
  `)

  return sqlite
}

describe('MKT-021 Bundles/Kits - Business Logic & D1 Store', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  describe('Pure helper calculations', () => {
    it('calculates bundle availability from component inventory', () => {
      // Variant 1: effective stock = 18, required = 2 => floor(18/2) = 9
      // Variant 2: effective stock = 15, required = 3 => floor(15/3) = 5
      const availability = calculateBundleAvailability([
        { effectiveStock: 18, quantity: 2 },
        { effectiveStock: 15, quantity: 3 }
      ])
      expect(availability).toBe(5)
    })

    it('returns 0 availability if any required component is out of stock', () => {
      const availability = calculateBundleAvailability([
        { effectiveStock: 18, quantity: 2 },
        { effectiveStock: 0, quantity: 1 }
      ])
      expect(availability).toBe(0)
    })

    it('calculates bundle pricing, savings and VAT correctly', () => {
      // Comp 1: 2500 cents * 2 = 5000 cents
      // Comp 2: 2000 cents * 1 = 2000 cents
      // Standalone sum = 7000 cents (gross)
      // Bundle price = 5600 cents (20% discount)
      const res = calculateBundlePricing({
        baseBundlePriceCents: 5600,
        kitQuantity: 2,
        components: [
          { unitPriceCents: 2500, taxRate: 0.21, defaultQuantity: 2 },
          { unitPriceCents: 2000, taxRate: 0.21, defaultQuantity: 1 }
        ]
      })

      expect(res.equivalentStandaloneCents).toBe(14000) // 7000 * 2 kits
      expect(res.bundlePriceCents).toBe(11200) // 5600 * 2 kits
      expect(res.savingsCents).toBe(2800) // 14000 - 11200
      expect(res.savingsPercent).toBe(20.0)
      expect(res.taxCents).toBeGreaterThan(0)
      expect(res.totalCents).toBe(res.bundlePriceCents + res.taxCents)
    })

    it('recalculates proration when user edits component quantities', () => {
      // Comp 1: default 2, edited to 3 (3 * 2500 = 7500)
      // Comp 2: default 1, kept at 1 (1 * 2000 = 2000)
      // Standalone sum = 9500 cents
      // Base was 7000 vs 5600 (20% off)
      const res = calculateBundlePricing({
        baseBundlePriceCents: 5600,
        kitQuantity: 1,
        components: [
          { unitPriceCents: 2500, taxRate: 0.21, defaultQuantity: 2, customQuantity: 3 },
          { unitPriceCents: 2000, taxRate: 0.21, defaultQuantity: 1, customQuantity: 1 }
        ]
      })

      expect(res.equivalentStandaloneCents).toBe(9500)
      // 20% discount applied to 9500 => 7600
      expect(res.bundlePriceCents).toBe(7600)
      expect(res.savingsCents).toBe(1900)
      expect(res.savingsPercent).toBe(20.0)
    })
  })

  describe('D1 Bundle Commands & CAS', () => {
    it('creates a new bundle with components and command audit journal', async () => {
      const bundle = await createD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000001',
        idempotencyKey: 'idem-create-bundle-1',
        title: 'Kit Desengrase y Desinfección Cocinas',
        slug: 'kit-desengrase-cocinas',
        description: 'Kit completo profesional para cumplimiento APPCC en hostelería.',
        sector: 'hosteleria',
        task: 'desengrase_profundo',
        bundlePriceCents: 3800,
        items: [
          { variantId: VARIANT_ID_1, quantity: 2, minQuantity: 1, maxQuantity: 10 },
          { variantId: VARIANT_ID_2, quantity: 1, minQuantity: 1, maxQuantity: 5 }
        ],
        now: NOW
      })

      expect(bundle.id).toBeDefined()
      expect(bundle.slug).toBe('kit-desengrase-cocinas')
      expect(bundle.bundlePriceCents).toBe(3800)
      expect(bundle.version).toBe(1)
      expect(bundle.items).toHaveLength(2)

      // Query by slug
      const found = await getD1BundleBySlug(db, 'kit-desengrase-cocinas')
      expect(found).not.toBeNull()
      expect(found?.title).toBe('Kit Desengrase y Desinfección Cocinas')
      expect(found?.maxAvailableKits).toBe(9) // min(floor((20-2)/2)=9, floor(15/1)=15)
      expect(found?.equivalentStandaloneCents).toBe(7000) // (2*2500) + (1*2000)
      expect(found?.savingsCents).toBe(3200) // 7000 - 3800
      expect(found?.savingsPercent).toBe(45.7)
    })

    it('rejects duplicate idempotency key with idempotency replay', async () => {
      const payload = {
        commandId: 'b0000000-0000-4000-8000-000000000002',
        idempotencyKey: 'idem-create-bundle-replay',
        title: 'Kit Sanitario Lavado',
        slug: 'kit-sanitario-lavado',
        description: 'Kit para desinfección de clínicas.',
        sector: 'sanitario' as const,
        task: 'desinfeccion_superficies' as const,
        bundlePriceCents: 4000,
        items: [{ variantId: VARIANT_ID_1, quantity: 1, minQuantity: 1, maxQuantity: 5 }],
        now: NOW
      }

      const first = await createD1Bundle(db, ADMIN_CLAIMS, payload)
      const second = await createD1Bundle(db, ADMIN_CLAIMS, payload)
      expect(first.id).toBe(second.id)
    })

    it('updates bundle with CAS version verification', async () => {
      const created = await createD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000003',
        idempotencyKey: 'idem-create-bundle-cas',
        title: 'Kit Inicial',
        slug: 'kit-inicial',
        description: 'Kit de prueba.',
        sector: 'general',
        task: 'limpieza_general',
        bundlePriceCents: 3500,
        items: [{ variantId: VARIANT_ID_1, quantity: 1, minQuantity: 1, maxQuantity: 5 }],
        now: NOW
      })

      // CAS conflict: expected version 2 when version is 1
      await expect(
        updateD1Bundle(db, ADMIN_CLAIMS, {
          commandId: 'b0000000-0000-4000-8000-000000000004',
          idempotencyKey: 'idem-update-fail',
          bundleId: created.id,
          expectedVersion: 2,
          bundlePriceCents: 3200,
          now: NOW
        })
      ).rejects.toThrow(BundleError)

      // Successful CAS update with version 1 -> 2
      const updated = await updateD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000005',
        idempotencyKey: 'idem-update-ok',
        bundleId: created.id,
        expectedVersion: 1,
        bundlePriceCents: 3200,
        now: NOW
      })

      expect(updated.version).toBe(2)
      expect(updated.bundlePriceCents).toBe(3200)
    })

    it('archives bundle and excludes from active public listings', async () => {
      const created = await createD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000006',
        idempotencyKey: 'idem-create-arch',
        title: 'Kit Temporal',
        slug: 'kit-temporal',
        description: 'Kit para archivar.',
        sector: 'industrial',
        task: 'desengrase_profundo',
        bundlePriceCents: 3000,
        items: [{ variantId: VARIANT_ID_1, quantity: 1, minQuantity: 1, maxQuantity: 5 }],
        now: NOW
      })

      await archiveD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000007',
        idempotencyKey: 'idem-arch-ok',
        bundleId: created.id,
        expectedVersion: 1,
        now: NOW
      })

      const list = await listD1Bundles(db, { sector: 'industrial' })
      expect(list.items.find((b) => b.id === created.id)).toBeUndefined()
    })

    it('allows customized component selections with recalculation', async () => {
      const created = await createD1Bundle(db, ADMIN_CLAIMS, {
        commandId: 'b0000000-0000-4000-8000-000000000008',
        idempotencyKey: 'idem-create-calc',
        title: 'Kit Configurable',
        slug: 'kit-configurable',
        description: 'Kit con cantidades editables.',
        sector: 'hosteleria',
        task: 'desengrase_profundo',
        bundlePriceCents: 3500, // Standalone would be 2500+2000 = 4500
        items: [
          { variantId: VARIANT_ID_1, quantity: 1, minQuantity: 1, maxQuantity: 5 },
          { variantId: VARIANT_ID_2, quantity: 1, minQuantity: 1, maxQuantity: 5 }
        ],
        now: NOW
      })

      // User customizes quantity of variant 1 to 2
      const selection = await calculateD1BundleSelection(db, {
        bundleId: created.id,
        kitQuantity: 1,
        customQuantities: {
          [VARIANT_ID_1]: 2
        }
      })

      expect(selection.equivalentStandaloneCents).toBe(7000) // (2*2500) + (1*2000)
      expect(selection.bundlePriceCents).toBeLessThan(7000)
      expect(selection.savingsCents).toBeGreaterThan(0)
      expect(selection.inStock).toBe(true)
    })
  })
})
