import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  getWarehouseQueues,
  processBarcodeScan,
  reportWarehouseException,
  resolveWarehouseException,
  listWarehousePrinters,
  dispatchWarehousePrintJob,
  getWarehouseOperationalMetrics,
  createWarehouseReception,
  WarehouseScanError
} from '../../workers/fulfillment/warehouse-scan-operations'

const OPERATOR_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000031',
  sessionId: '20000000-0000-4000-8000-000000000031',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('warehouse', 'Operario de Almacén', 'Rol almacén'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('fulfillment.manage', 'fulfillment', 'manage', 'Gestión fulfillment');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('warehouse', 'fulfillment.manage'),
      ('warehouse', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${OPERATOR_CLAIMS.identityId}', 'operario@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'unauth@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${OPERATOR_CLAIMS.sessionId}', '${OPERATOR_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('${UNAUTHORIZED_CLAIMS.sessionId}', '${UNAUTHORIZED_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${OPERATOR_CLAIMS.identityId}', 'warehouse', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest', '${NOW}');

    -- Seed test printer
    INSERT OR IGNORE INTO warehouse_printers (id, name, location, protocol, endpoint_address, status, supported_formats_json, updated_at) VALUES
      ('printer-zebra-01', 'Zebra ZT411 Picking', 'Zona A - Muelle 1', 'zpl', 'tcp://192.168.10.45:9100', 'online', '["parcel_4x6","shelf_barcode","lot_tag"]', '${NOW}');
  `)

  return sqlite
}

describe('ADM-031: Warehouse Scan Operations Core', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates reception queue item and processes barcode scans', async () => {
    const reception = await createWarehouseReception(
      db,
      OPERATOR_CLAIMS,
      {
        supplierName: 'Química del Sureste S.A.',
        referenceCode: 'ALB-2026-9982',
        expectedItems: [
          {
            sku: 'CLO-5000',
            barcode: '8437001234567',
            name: 'Hipoclorito Sódico 14% 25L',
            expectedQty: 10,
            scannedQty: 0,
            location: 'A-01-02'
          }
        ]
      },
      { commandId: '30000000-0000-4000-8000-000000000041', now: NOW }
    )

    expect(reception.id).toBeDefined()
    expect(reception.status).toBe('pending')

    // Scan 5 units of valid barcode
    const scanResult = await processBarcodeScan(
      db,
      OPERATOR_CLAIMS,
      {
        queueType: 'reception',
        targetId: reception.id,
        barcode: '8437001234567',
        quantity: 5,
        location: 'A-01-02'
      },
      { commandId: '30000000-0000-4000-8000-000000000042', now: NOW }
    )

    expect(scanResult.success).toBe(true)
    expect(scanResult.scannedQty).toBe(5)
    expect(scanResult.remainingQty).toBe(5)

    // Complete the remaining 5 units
    const completeScan = await processBarcodeScan(
      db,
      OPERATOR_CLAIMS,
      {
        queueType: 'reception',
        targetId: reception.id,
        barcode: '8437001234567',
        quantity: 5,
        location: 'A-01-02'
      },
      { commandId: '30000000-0000-4000-8000-000000000043', now: NOW }
    )

    expect(completeScan.remainingQty).toBe(0)
    expect(completeScan.queueItemStatus).toBe('completed')
  })

  it('rejects scan when barcode does not match expected items', async () => {
    const reception = await createWarehouseReception(
      db,
      OPERATOR_CLAIMS,
      {
        supplierName: 'Química del Sureste S.A.',
        referenceCode: 'ALB-2026-9983',
        expectedItems: [
          {
            sku: 'CLO-5000',
            barcode: '8437001234567',
            name: 'Hipoclorito Sódico 14% 25L',
            expectedQty: 5,
            scannedQty: 0
          }
        ]
      },
      { commandId: '30000000-0000-4000-8000-000000000044', now: NOW }
    )

    await expect(
      processBarcodeScan(
        db,
        OPERATOR_CLAIMS,
        {
          queueType: 'reception',
          targetId: reception.id,
          barcode: '9999999999999', // Unknown barcode
          quantity: 1
        },
        { commandId: '30000000-0000-4000-8000-000000000045', now: NOW }
      )
    ).rejects.toThrow(WarehouseScanError)
  })

  it('handles exception mode workflow (reporting and resolving exception)', async () => {
    const exception = await reportWarehouseException(
      db,
      OPERATOR_CLAIMS,
      {
        targetType: 'reception',
        targetId: 'ALB-2026-9984',
        exceptionType: 'spill_hazard',
        severity: 'critical',
        reason: 'Envase de 25L presenta fuga en tapón con olor fuerte a cloro, retenido en cubeto de contención'
      },
      { commandId: '30000000-0000-4000-8000-000000000046', now: NOW }
    )

    expect(exception.id).toBeDefined()
    expect(exception.status).toBe('open')
    expect(exception.severity).toBe('critical')

    // Resolve exception
    const resolved = await resolveWarehouseException(
      db,
      OPERATOR_CLAIMS,
      exception.id,
      {
        resolution: 'resolved',
        resolutionNotes: 'Neutralizado con absorbente inerte y devuelto al proveedor para abono'
      },
      { commandId: '30000000-0000-4000-8000-000000000047', now: NOW }
    )

    expect(resolved.status).toBe('resolved')
    expect(resolved.resolvedBy).toBe(OPERATOR_CLAIMS.identityId)
  })

  it('lists warehouse printers and dispatches print jobs deterministically', async () => {
    const printers = await listWarehousePrinters(db, OPERATOR_CLAIMS)
    expect(printers.length).toBeGreaterThanOrEqual(1)
    expect(printers[0].id).toBe('printer-zebra-01')

    const printJob = await dispatchWarehousePrintJob(
      db,
      OPERATOR_CLAIMS,
      {
        printerId: 'printer-zebra-01',
        labelType: 'parcel_4x6',
        documentId: 'DOC-LABEL-001',
        copies: 2
      },
      { commandId: '30000000-0000-4000-8000-000000000048', now: NOW }
    )

    expect(printJob.status).toBe('completed')
    expect(printJob.copies).toBe(2)
  })

  it('calculates operational warehouse metrics across queues and active scanners', async () => {
    const metrics = await getWarehouseOperationalMetrics(db, OPERATOR_CLAIMS, { now: NOW })

    expect(metrics.queueCounts).toBeDefined()
    expect(metrics.queueCounts.reception).toBeDefined()
    expect(metrics.queueCounts.picking).toBeDefined()
    expect(metrics.queueCounts.packing).toBeDefined()
    expect(metrics.queueCounts.exceptions).toBeDefined()
    expect(metrics.dailyStats).toBeDefined()
    expect(metrics.dailyStats.avgPickMinutes).toBeGreaterThanOrEqual(0)
    expect(metrics.dailyStats.avgPackMinutes).toBeGreaterThanOrEqual(0)
    expect(metrics.printers).toBeInstanceOf(Array)
  })

  it('retrieves warehouse queue items including reception and exceptions', async () => {
    const queues = await getWarehouseQueues(db, OPERATOR_CLAIMS, { now: NOW })
    expect(queues.reception).toBeInstanceOf(Array)
    expect(queues.picking).toBeInstanceOf(Array)
    expect(queues.packing).toBeInstanceOf(Array)
    expect(queues.exceptions).toBeInstanceOf(Array)
  })
})
