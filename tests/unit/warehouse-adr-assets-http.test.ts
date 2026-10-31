import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleWarehouseAdrAssetsHttp,
  ownsWarehouseAdrAssetsNamespace
} from '../../workers/fulfillment/warehouse-adr-assets-http'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const OPERATOR_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000022',
  sessionId: '20000000-0000-4000-8000-000000000022',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0141_templates_brand_warehouse_adr.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('warehouse', 'Almacén', 'Rol operario almacén');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('fulfillment.manage', 'fulfillment', 'manage', 'Gestión fulfillment');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('warehouse', 'fulfillment.manage'),
      ('warehouse', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${OPERATOR_CLAIMS.identityId}', 'almacen@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${OPERATOR_CLAIMS.sessionId}', '${OPERATOR_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${OPERATOR_CLAIMS.identityId}', 'warehouse', '${NOW}');

    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('t21', 'std', 'IVA 21%', 2100, '${NOW}');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES ('sp1', 'sp1', 'Estándar', 'parcel');
    INSERT OR IGNORE INTO categories (id, slug, name, status, legacy_id) VALUES
      ('cat-quimica-01', 'quimica-profesional', 'Química Profesional', 'published', 101);
    INSERT OR IGNORE INTO products (id, category_id, slug, name, status, legacy_id) VALUES
      ('prod-sosa-01', 'cat-quimica-01', 'hidroxido-sodico-sosa', 'Hidróxido Sódico Líquido (Sosa Cáustica)', 'published', 203);
    INSERT OR IGNORE INTO variants (id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents) VALUES
      ('var-sosa-25kg', 303, 'prod-sosa-01', 't21', 'sp1', 'NET-SOS-25KG', 'Bidón 25 kg', 'published', 3800);
  `)
  return sqlite
}

describe('MED-022: Warehouse ADR Assets HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('correctly matches ownsWarehouseAdrAssetsNamespace', () => {
    expect(ownsWarehouseAdrAssetsNamespace('/api/warehouse/operational-assets/variant/var-123')).toBe(true)
    expect(ownsWarehouseAdrAssetsNamespace('/api/warehouse/operational-assets/lot/LOT-001')).toBe(true)
    expect(ownsWarehouseAdrAssetsNamespace('/api/warehouse/operational-assets/generate-label')).toBe(true)
    expect(ownsWarehouseAdrAssetsNamespace('/api/warehouse/operational-assets/transport-document')).toBe(true)
    expect(ownsWarehouseAdrAssetsNamespace('/api/admin/warehouse/adr/spec')).toBe(true)
    expect(ownsWarehouseAdrAssetsNamespace('/api/admin/orders')).toBe(false)
  })

  it('handles spec registration, lot creation, and CLP label HTTP request', async () => {
    // 1. Post spec
    const postSpecReq = new Request('https://neteco.es/api/admin/warehouse/adr/spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'e1000000-0000-4000-8000-000000000001',
        variantId: 'var-sosa-25kg',
        unNumber: 'UN 1824',
        properShippingName: 'HIDRÓXIDO SÓDICO EN SOLUCIÓN',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3,
        pictograms: ['GHS05'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H314: Provoca quemaduras graves en la piel y lesiones oculares graves'],
        precautionaryStatements: ['P280: Llevar guantes y protección ocular'],
        ufiCode: 'UFI: 99B0-S01X-2201-1K2L',
        handlingInstructions: ['Almacenar sobre cubeto de retención resistente a álcalis.'],
        sdsVersion: 'REV-2026.2'
      })
    })
    const specRes = await handleWarehouseAdrAssetsHttp(postSpecReq, { database: db, claims: OPERATOR_CLAIMS, now: NOW })
    expect(specRes?.status).toBe(201)

    // 2. Post lot
    const postLotReq = new Request('https://neteco.es/api/admin/warehouse/adr/lot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'e1000000-0000-4000-8000-000000000002',
        lotNumber: 'LOT-SOSA-202610-01',
        variantId: 'var-sosa-25kg',
        specVersion: 1,
        manufacturingDate: '2026-10-28',
        expiryDate: '2028-10-28',
        unitsProduced: 80,
        qaReleaseStatus: 'approved'
      })
    })
    const lotRes = await handleWarehouseAdrAssetsHttp(postLotReq, { database: db, claims: OPERATOR_CLAIMS, now: NOW })
    expect(lotRes?.status).toBe(201)

    // 3. Post generate-label
    const labelReq = new Request('https://neteco.es/api/warehouse/operational-assets/generate-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variantId: 'var-sosa-25kg',
        lotNumber: 'LOT-SOSA-202610-01'
      })
    })
    const labelRes = await handleWarehouseAdrAssetsHttp(labelReq, { database: db, claims: OPERATOR_CLAIMS, now: NOW })
    expect(labelRes?.status).toBe(200)
    const labelBody = await labelRes?.json()
    expect(labelBody.productName).toBe('Hidróxido Sódico Líquido (Sosa Cáustica)')
    expect(labelBody.unNumber).toBe('UN 1824')
    expect(labelBody.pictograms).toEqual(['GHS05'])
  })

  it('generates transport document and queries variant handling instructions via HTTP', async () => {
    // 0. Setup spec and lot
    await handleWarehouseAdrAssetsHttp(
      new Request('https://neteco.es/api/admin/warehouse/adr/spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: 'e2000000-0000-4000-8000-000000000001',
          variantId: 'var-sosa-25kg',
          unNumber: 'UN 1824',
          properShippingName: 'HIDRÓXIDO SÓDICO EN SOLUCIÓN',
          adrClass: '8',
          packingGroup: 'II',
          tunnelCode: '(E)',
          limitedQuantity: '1 L',
          adrPointsFactor: 3,
          pictograms: ['GHS05'],
          signalWord: 'PELIGRO',
          hazardStatements: ['H314: Quemaduras graves'],
          precautionaryStatements: ['P280: Guantes'],
          ufiCode: 'UFI: 99B0-S01X-2201-1K2L',
          handlingInstructions: ['Cubeto resistente a álcalis'],
          sdsVersion: 'REV-2026.2'
        })
      }),
      { database: db, claims: OPERATOR_CLAIMS, now: NOW }
    )

    await handleWarehouseAdrAssetsHttp(
      new Request('https://neteco.es/api/admin/warehouse/adr/lot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: 'e2000000-0000-4000-8000-000000000002',
          lotNumber: 'LOT-SOSA-202610-01',
          variantId: 'var-sosa-25kg',
          specVersion: 1,
          manufacturingDate: '2026-10-28',
          expiryDate: '2028-10-28',
          unitsProduced: 80,
          qaReleaseStatus: 'approved'
        })
      }),
      { database: db, claims: OPERATOR_CLAIMS, now: NOW }
    )

    // 1. GET variant operational assets
    const getVariantReq = new Request('https://neteco.es/api/warehouse/operational-assets/variant/var-sosa-25kg', {
      method: 'GET'
    })
    const variantRes = await handleWarehouseAdrAssetsHttp(getVariantReq, { database: db, now: NOW })
    expect(variantRes?.status).toBe(200)
    const variantData = await variantRes?.json()
    expect(variantData.spec.unNumber).toBe('UN 1824')
    expect(variantData.instructions.requiredPpe.length).toBeGreaterThan(0)

    // 2. POST transport-document
    const docReq = new Request('https://neteco.es/api/warehouse/operational-assets/transport-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: 'e2000000-0000-4000-8000-000000000003',
        shipmentItems: [
          {
            lotNumber: 'LOT-SOSA-202610-01',
            packagesCount: 10,
            packageType: 'Bidón 25 kg',
            litersOrKgPerPackage: 25
          }
        ]
      })
    })
    const docRes = await handleWarehouseAdrAssetsHttp(docReq, { database: db, claims: OPERATOR_CLAIMS, now: NOW })
    expect(docRes?.status).toBe(200)
    const docData = await docRes?.json()
    // 10 * 25 = 250 kg * factor 3 = 750 points (exempt <= 1000)
    expect(docData.totalCalculatedPoints).toBe(750)
    expect(docData.isExemptUnder1136).toBe(true)
  })

  it('rejects unauthenticated requests to protected warehouse ADR endpoints with 401', async () => {
    const req = new Request('https://neteco.es/api/admin/warehouse/adr/spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: 'var-test' })
    })
    const res = await handleWarehouseAdrAssetsHttp(req, { database: db, now: NOW })
    expect(res?.status).toBe(401)
  })

  it('returns 400 for missing required fields in generate-label request', async () => {
    const req = new Request('https://neteco.es/api/warehouse/operational-assets/generate-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: 'var-sosa-25kg' }) // missing lotNumber
    })
    const res = await handleWarehouseAdrAssetsHttp(req, { database: db, claims: OPERATOR_CLAIMS, now: NOW })
    expect(res?.status).toBe(400)
    const body = await res?.json()
    expect(body.error?.code).toBe('invalid_input')
  })
})
