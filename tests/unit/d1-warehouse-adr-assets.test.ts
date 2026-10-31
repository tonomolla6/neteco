import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  upsertVariantAdrSpec,
  createWarehouseLotRecord,
  generateClpContainerLabel,
  generateAdrTransportDocument,
  getWarehouseHandlingInstructions,
  WarehouseAdrError
} from '../../workers/fulfillment/warehouse-adr-assets'

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

    -- Insert mock product and variant for testing
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('t21', 'std', 'IVA 21%', 2100, '${NOW}');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES ('sp1', 'sp1', 'Estándar', 'parcel');
    INSERT OR IGNORE INTO categories (id, slug, name, status, legacy_id) VALUES
      ('cat-quimica-01', 'quimica-profesional', 'Química Profesional', 'published', 101);
    INSERT OR IGNORE INTO products (id, category_id, slug, name, status, legacy_id) VALUES
      ('prod-cloro-01', 'cat-quimica-01', 'hipoclorito-neteco-150', 'Hipoclorito Sódico Neteco 150g/L', 'published', 201),
      ('prod-detergente-neutro', 'cat-quimica-01', 'detergente-neutro-eco', 'Detergente Neutro Eco-Limp', 'published', 202);
    INSERT OR IGNORE INTO variants (id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents) VALUES
      ('var-cloro-5l', 301, 'prod-cloro-01', 't21', 'sp1', 'NET-CLO-5L', 'Garrafa 5 Litros', 'published', 1500),
      ('var-detergente-5l', 302, 'prod-detergente-neutro', 't21', 'sp1', 'NET-DET-5L', 'Garrafa 5 Litros', 'published', 1200);
  `)
  return sqlite
}

describe('MED-022: Assets operativos de almacén y ADR por variante y lote (D1 Core)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('manages variant ADR specs and generates versioned CLP container labels by lot', async () => {
    // 1. Create ADR specification for variant
    const spec = await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000001',
        variantId: 'var-cloro-5l',
        unNumber: 'UN 1791',
        properShippingName: 'HIPOCLORITO EN SOLUCIÓN (CLORO ACTIVO > 10%)',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3, // Transport Category 2 -> factor 3
        pictograms: ['GHS05', 'GHS09'], // Corrosive + Environment
        signalWord: 'PELIGRO',
        hazardStatements: [
          'H314: Provoca quemaduras graves en la piel y lesiones oculares graves',
          'H400: Muy tóxico para los organismos acuáticos',
          'H290: Puede ser corrosivo para los metales'
        ],
        precautionaryStatements: [
          'P260: No respirar los vapores',
          'P280: Llevar guantes, prendas y gafas de protección',
          'P305+P351+P338: EN CASO DE CONTACTO CON LOS OJOS: Aclarar cuidadosamente con agua durante varios minutos'
        ],
        ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
        handlingInstructions: [
          'Almacenar en lugar fresco entre 5°C y 20°C protegido de la luz solar directa.',
          'Incompatible con ácidos fuertes: libera gas cloro tóxico.',
          'Apilamiento máximo de 2 alturas de palets con separador.'
        ],
        sdsVersion: 'REV-2026.3'
      },
      NOW
    )
    expect(spec.unNumber).toBe('UN 1791')
    expect(spec.version).toBe(1)

    // 2. Register warehouse production lot
    const lot = await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000002',
        lotNumber: 'LOT-202610-042',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 240,
        qaReleaseStatus: 'approved'
      },
      NOW
    )
    expect(lot.lotNumber).toBe('LOT-202610-042')
    expect(lot.qaReleaseStatus).toBe('approved')

    // 3. Generate CLP chemical container label
    const label = await generateClpContainerLabel(db, 'var-cloro-5l', 'LOT-202610-042', NOW)
    expect(label.productName).toBe('Hipoclorito Sódico Neteco 150g/L')
    expect(label.variantLabel).toBe('Garrafa 5 Litros')
    expect(label.lotNumber).toBe('LOT-202610-042')
    expect(label.unNumber).toBe('UN 1791')
    expect(label.signalWord).toBe('PELIGRO')
    expect(label.pictograms).toEqual(['GHS05', 'GHS09'])
    expect(label.emergencyPhone).toBe('+34 91 562 04 20') // INTCF mandatory
    expect(label.ufiCode).toBe('UFI: 42A0-E03Y-9008-7H9X')
    expect(label.barcodeData).toContain('LOT-202610-042')

    // 4. Warehouse handling instructions
    const instructions = await getWarehouseHandlingInstructions(db, 'var-cloro-5l', 'LOT-202610-042', NOW)
    expect(instructions.storageConditions.length).toBeGreaterThan(0)
    expect(instructions.incompatibleMaterials).toContain('Incompatible con ácidos fuertes: libera gas cloro tóxico.')
  })

  it('generates compliant ADR transport document and calculates 1.1.3.6 exemption points correctly', async () => {
    // 1. Setup hazardous variant spec
    await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000003',
        variantId: 'var-cloro-5l',
        unNumber: 'UN 1791',
        properShippingName: 'HIPOCLORITO EN SOLUCIÓN',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3, // Transport Category 2 -> factor 3
        pictograms: ['GHS05', 'GHS09'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H314: Quemaduras graves'],
        precautionaryStatements: ['P280: Guantes'],
        ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
        handlingInstructions: ['Fresco y ventilado'],
        sdsVersion: 'REV-2026.3'
      },
      NOW
    )
    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000004',
        lotNumber: 'LOT-CLORO-A',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 100,
        qaReleaseStatus: 'approved'
      },
      NOW
    )

    // 2. Setup non-hazardous product variant
    await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000005',
        variantId: 'var-detergente-5l',
        unNumber: 'NONE',
        properShippingName: 'MERCANCÍA NO PELIGROSA PARA TRANSPORTE',
        adrClass: 'NONE',
        packingGroup: 'NONE',
        tunnelCode: 'NONE',
        limitedQuantity: 'NONE',
        adrPointsFactor: 0,
        pictograms: [],
        signalWord: 'NONE',
        hazardStatements: [],
        precautionaryStatements: ['P102: Mantener fuera del alcance de los niños'],
        ufiCode: null,
        handlingInstructions: ['Almacenar en lugar seco'],
        sdsVersion: 'REV-2026.1'
      },
      NOW
    )
    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000006',
        lotNumber: 'LOT-DET-A',
        variantId: 'var-detergente-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2028-10-25',
        unitsProduced: 200,
        qaReleaseStatus: 'approved'
      },
      NOW
    )

    // 3. Generate ADR transport document for 20 packages of Cloro (5L each = 100L) + 10 packages Detergent
    const doc = await generateAdrTransportDocument(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000007',
        shipmentItems: [
          {
            lotNumber: 'LOT-CLORO-A',
            packagesCount: 20,
            packageType: 'Jerricanes 5L (3H1)',
            litersOrKgPerPackage: 5
          },
          {
            lotNumber: 'LOT-DET-A',
            packagesCount: 10,
            packageType: 'Cajas 2x5L',
            litersOrKgPerPackage: 10
          }
        ]
      },
      NOW
    )

    // 20 * 5 = 100 L of UN 1791 (factor 3) = 300 points.
    // Detergent = 0 points.
    // Total points = 300.
    // 300 <= 1000 -> isExemptUnder1136 is TRUE!
    expect(doc.totalCalculatedPoints).toBe(300)
    expect(doc.isExemptUnder1136).toBe(true)
    expect(doc.mandatoryDeclaration).toContain('transporte que no sobrepasa los límites fijados en el 1.1.3.6')
    expect(doc.lines).toHaveLength(2)
  })

  it('rejects label generation if lot is in quarantine or rejected', async () => {
    await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000008',
        variantId: 'var-cloro-5l',
        unNumber: 'UN 1791',
        properShippingName: 'HIPOCLORITO EN SOLUCIÓN',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3,
        pictograms: ['GHS05'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H314'],
        precautionaryStatements: ['P280'],
        ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
        handlingInstructions: ['Fresco'],
        sdsVersion: 'REV-2026.3'
      },
      NOW
    )

    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000009',
        lotNumber: 'LOT-QUARANTINE-99',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 50,
        qaReleaseStatus: 'quarantine'
      },
      NOW
    )

    await expect(generateClpContainerLabel(db, 'var-cloro-5l', 'LOT-QUARANTINE-99', NOW)).rejects.toThrow(
      WarehouseAdrError
    )
  })

  it('correctly classifies non-exempt shipment when ADR 1.1.3.6 total points exceed 1000', async () => {
    await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000010',
        variantId: 'var-cloro-5l',
        unNumber: 'UN 1791',
        properShippingName: 'HIPOCLORITO EN SOLUCIÓN',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3,
        pictograms: ['GHS05'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H314'],
        precautionaryStatements: ['P280'],
        ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
        handlingInstructions: ['Fresco'],
        sdsVersion: 'REV-2026.3'
      },
      NOW
    )
    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000011',
        lotNumber: 'LOT-CLORO-HIGH-ADR',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 500,
        qaReleaseStatus: 'approved'
      },
      NOW
    )

    // 80 packages of 5L Cloro = 400 L * factor 3 = 1200 points (> 1000 points!)
    const doc = await generateAdrTransportDocument(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000012',
        shipmentItems: [
          {
            lotNumber: 'LOT-CLORO-HIGH-ADR',
            packagesCount: 80,
            packageType: 'Jerricanes 5L (3H1)',
            litersOrKgPerPackage: 5
          }
        ]
      },
      NOW
    )

    expect(doc.totalCalculatedPoints).toBe(1200)
    expect(doc.isExemptUnder1136).toBe(false)
    expect(doc.mandatoryDeclaration).toContain('Transporte de mercancías peligrosas sujeto a la totalidad')
    expect(doc.mandatoryDeclaration).toContain('Conductor con certificado ADR obligatorio')
  })

  it('rejects label generation if QA status is rejected', async () => {
    await upsertVariantAdrSpec(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000013',
        variantId: 'var-cloro-5l',
        unNumber: 'UN 1791',
        properShippingName: 'HIPOCLORITO EN SOLUCIÓN',
        adrClass: '8',
        packingGroup: 'II',
        tunnelCode: '(E)',
        limitedQuantity: '1 L',
        adrPointsFactor: 3,
        pictograms: ['GHS05'],
        signalWord: 'PELIGRO',
        hazardStatements: ['H314'],
        precautionaryStatements: ['P280'],
        ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
        handlingInstructions: ['Fresco'],
        sdsVersion: 'REV-2026.3'
      },
      NOW
    )

    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000014',
        lotNumber: 'LOT-REJECTED-001',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 20,
        qaReleaseStatus: 'rejected'
      },
      NOW
    )

    await expect(generateClpContainerLabel(db, 'var-cloro-5l', 'LOT-REJECTED-001', NOW)).rejects.toThrow(
      WarehouseAdrError
    )
  })

  it('enforces immutability on warehouse ADR commands ledger', async () => {
    await createWarehouseLotRecord(
      db,
      OPERATOR_CLAIMS,
      {
        commandId: 'd1000000-0000-4000-8000-000000000015',
        lotNumber: 'LOT-IMMUTABLE-01',
        variantId: 'var-cloro-5l',
        specVersion: 1,
        manufacturingDate: '2026-10-25',
        expiryDate: '2027-10-25',
        unitsProduced: 10,
        qaReleaseStatus: 'approved'
      },
      NOW
    )

    expect(() => {
      sqlite.exec(
        "UPDATE warehouse_adr_commands SET action='qa_release_lot' WHERE command_id='d1000000-0000-4000-8000-000000000015'"
      )
    }).toThrow(/warehouse_adr_commands_immutable/)
  })
})
