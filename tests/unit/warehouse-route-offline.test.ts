import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  executeWarehouseScan,
  executePrintJob,
  executeOfflineReconnectionSync,
  handleDuplicateScan,
  handleLostDeviceRevocation,
  reconcileFulfillmentAndInventory
} from '../../workers/fulfillment/warehouse-route-offline'

export interface WarehouseRouteWorld {
  sqlite: DatabaseSync
  database: D1Database
  operatorClaims: VerifiedSessionClaims
  driverClaims: VerifiedSessionClaims
  adminClaims: VerifiedSessionClaims
  receptionId: string
  routeId: string
  stopId: string
  orderId: string
}

const NOW = '2026-10-31T08:00:00Z'
const PAST = '2026-01-01T00:00:00Z'
const FUTURE = '2030-01-01T00:00:00Z'

export async function setupWarehouseRouteFixture(sqlite: DatabaseSync): Promise<WarehouseRouteWorld> {
  // Apply migrations for routes, delivery app and warehouse scanning
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0109_shipping_convenience_conditions_routes.sql', import.meta.url),
      'utf8'
    )
  )
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0129_delivery_app_carrier_manifests_packing_optimizer.sql', import.meta.url),
      'utf8'
    )
  )
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql', import.meta.url),
      'utf8'
    )
  )

  // Baseline inventory fixture
  seedInventoryFixture(sqlite)

  const operatorClaims: VerifiedSessionClaims = {
    identityId: '10000000-0000-4000-8000-000000000031',
    sessionId: '20000000-0000-4000-8000-000000000031',
    sessionVersion: 1
  }

  const driverClaims: VerifiedSessionClaims = {
    identityId: '10000000-0000-4000-8000-000000000032',
    sessionId: '20000000-0000-4000-8000-000000000032',
    sessionVersion: 1
  }

  const adminClaims: VerifiedSessionClaims = {
    identityId: '10000000-0000-4000-8000-000000000033',
    sessionId: '20000000-0000-4000-8000-000000000033',
    sessionVersion: 1
  }

  // Setup identities, sessions, roles
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('warehouse', 'Operario Almacén', 'Rol almacén'),
      ('driver', 'Conductor', 'Rol conductor');

    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage'),
      ('fulfillment.manage', 'fulfillment', 'manage', 'Fulfillment manage');

    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('warehouse', 'fulfillment.manage'),
      ('warehouse', 'administration.manage');

    INSERT INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${operatorClaims.identityId}', 'operario@neteco.invalid', 'hash', '${PAST}', 'active', '${PAST}', '${PAST}'),
      ('${driverClaims.identityId}', 'conductor@neteco.invalid', 'hash', '${PAST}', 'active', '${PAST}', '${PAST}'),
      ('${adminClaims.identityId}', 'admin@neteco.invalid', 'hash', '${PAST}', 'active', '${PAST}', '${PAST}');

    INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${operatorClaims.sessionId}', '${operatorClaims.identityId}', 1, 1, '${PAST}', '${FUTURE}'),
      ('${driverClaims.sessionId}', '${driverClaims.identityId}', 1, 1, '${PAST}', '${FUTURE}'),
      ('${adminClaims.sessionId}', '${adminClaims.identityId}', 1, 1, '${PAST}', '${FUTURE}');

    INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${operatorClaims.identityId}', 'warehouse', '${PAST}'),
      ('${driverClaims.identityId}', 'driver', '${PAST}'),
      ('${adminClaims.identityId}', 'admin', '${PAST}');
  `)

  // Setup Printers
  sqlite.exec(`
    INSERT INTO warehouse_printers (id, name, location, protocol, endpoint_address, status, supported_formats_json, updated_at) VALUES
      ('printer-zpl-01', 'Zebra Packing 1', 'Muelle 1', 'zpl', 'tcp://192.168.1.50:9100', 'online', '["parcel_4x6"]', '${PAST}'),
      ('printer-offline-02', 'Zebra Packing 2', 'Muelle 2', 'zpl', 'tcp://192.168.1.51:9100', 'offline', '["parcel_4x6"]', '${PAST}');
  `)

  // Setup Warehouse Reception
  const receptionId = '50000000-0000-4000-8000-000000000001'
  const expectedItems = [
    {
      sku: 'DES-5L',
      barcode: '8437000000012',
      name: 'Desengrasante 5L',
      expectedQty: 10,
      scannedQty: 0
    }
  ]
  sqlite.exec(`
    INSERT INTO warehouse_receptions (
      id, supplier_name, reference_code, expected_items_json, received_items_json, status, version, created_by, created_at, updated_at
    ) VALUES (
      '${receptionId}', 'Quimicos del Mediterraneo', 'REF-2026-REC-01', '${JSON.stringify(expectedItems)}', '[]', 'pending', 1, '${operatorClaims.identityId}', '${PAST}', '${PAST}'
    );
  `)

  // Setup Driver, Vehicle, Route and Stop
  const driverId = 'drv-01'
  const vehicleId = 'veh-01'
  const routeId = '60000000-0000-4000-8000-000000000001'
  const stopId = '70000000-0000-4000-8000-000000000001'

  sqlite.exec(`
    INSERT INTO delivery_vehicles (id, name, registration_plate, max_weight_grams, max_parcels, status, created_at, updated_at) VALUES
      ('${vehicleId}', 'Furgoneta 1', '1234-BBB', 1500000, 50, 'active', '${PAST}', '${PAST}');

    INSERT INTO delivery_drivers (id, identity_id, name, phone, license_number, status, created_at, updated_at) VALUES
      ('${driverId}', '${driverClaims.identityId}', 'Carlos Conductor', '+34600123456', 'LIC-B-1234', 'active', '${PAST}', '${PAST}');

    INSERT INTO delivery_routes (
      id, route_date, vehicle_id, driver_id, status, window_start, window_end, total_stops, total_parcels, total_weight_grams, version, created_at, updated_at
    ) VALUES (
      '${routeId}', '2026-10-31', '${vehicleId}', '${driverId}', 'planned', '08:00', '14:00', 1, 1, 5000, 1, '${PAST}', '${PAST}'
    );

    INSERT INTO delivery_route_stops (
      id, route_id, sequence_index, recipient_name, street_address, postal_code, city, parcel_count, weight_grams, status
    ) VALUES (
      '${stopId}', '${routeId}', 0, 'Encargado Almacén', 'Poligono Industrial 1', '46870', 'Ontinyent', 1, 5000, 'pending'
    );
  `)

  // Setup shipping zones and rates for cart checkout
  sqlite.exec(`
    INSERT OR IGNORE INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at)
      VALUES('pickup-zone','pickup','Pickup','warehouse_pickup','[]',1,'${PAST}');
    INSERT OR IGNORE INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
      VALUES('pickup-rate','pickup-zone','pickup','parcel',0,2100,0,0,1,1,'${PAST}');
  `)

  const database = d1OverSqlite(sqlite)
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: PAST })

  // Setup Order and Inventory Reconciliation state via real checkout
  const cart = await createCart(database, { correlationId: 'wh-order', now: NOW })
  await setCartLine(database, {
    cartId: cart.cartId,
    token: cart.token,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'wh-line',
    correlationId: 'wh-order',
    now: NOW
  })
  const shipping = await requestShippingOptions(database, {
    cartId: cart.cartId,
    token: cart.token,
    destination: { city: 'Ontinyent', postalCode: '46870' },
    expectedVersion: 2,
    idempotencyKey: 'wh-shipping',
    correlationId: 'wh-order',
    now: NOW
  })
  if (!('body' in shipping)) {
    throw new Error('Failed to request shipping options')
  }
  const options = shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
  const option = options.find((item) => item.methodCode === 'pickup')!
  const quote = await quoteCart(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    idempotencyKey: 'wh-quote',
    correlationId: 'wh-order',
    now: NOW
  })
  if (!('quote' in quote)) {
    throw new Error('Failed to quote cart')
  }
  const placed = await placeOrder(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    contactEmail: 'cliente@test.invalid',
    contactName: 'Test Contact',
    contactPhone: '+34600111222',
    shippingAddress: {
      recipientName: 'Test Recipient',
      line1: 'Calle Mayor 1',
      city: 'Ontinyent',
      province: 'València',
      postalCode: '46870',
      countryCode: 'ES',
      phone: '+34600111222'
    },
    consentTos: true,
    consentPrivacy: true,
    idempotencyKey: 'wh-order-placed',
    correlationId: 'wh-order',
    now: NOW
  })
  if (!('body' in placed)) {
    throw new Error('Failed to place order')
  }
  const orderId = (placed.body as { id: string }).id

  return {
    sqlite,
    database,
    operatorClaims,
    driverClaims,
    adminClaims,
    receptionId,
    routeId,
    stopId,
    orderId
  }
}

describe('TST-043: Warehouse, route and offline operations test suite', () => {
  let sqlite: DatabaseSync
  let world: WarehouseRouteWorld

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    world = await setupWarehouseRouteFixture(sqlite)
  })

  afterEach(() => {
    if (sqlite?.isOpen) {
      sqlite.close()
    }
  })

  it('1. Escaneo: Valid barcode scan updates quantity, invalid barcode raises mismatch exception', async () => {
    // 1a: Valid barcode scan for reception
    const scanResult = await executeWarehouseScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      quantity: 5
    })
    expect(scanResult.success).toBe(true)
    expect(scanResult.scannedQty).toBe(5)
    expect(scanResult.remainingQty).toBe(5) // expected 10, scanned 5
    expect(scanResult.queueItemStatus).toBe('in_progress')

    // 1b: Second valid scan completes the reception
    const scanComplete = await executeWarehouseScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      quantity: 5
    })
    expect(scanComplete.scannedQty).toBe(10)
    expect(scanComplete.remainingQty).toBe(0)
    expect(scanComplete.queueItemStatus).toBe('completed')

    // 1c: Unknown barcode throws and reports exception
    await expect(
      executeWarehouseScan(world.database, world.operatorClaims, {
        queueType: 'reception',
        targetId: world.receptionId,
        barcode: 'UNKNOWN-BARCODE-999',
        quantity: 1
      })
    ).rejects.toMatchObject({ code: 'barcode_not_found' })
  })

  it('2. Impresión: Label print job succeeds on active printer and fails gracefully on offline printer', async () => {
    // 2a: Print on active online printer
    const printResult = await executePrintJob(world.database, world.operatorClaims, {
      printerId: 'printer-zpl-01',
      labelType: 'parcel_4x6',
      documentId: 'DOC-SHIP-001',
      copies: 1
    })
    expect(printResult.status).toBe('completed')
    expect(printResult.copies).toBe(1)

    // 2b: Print on offline printer
    await expect(
      executePrintJob(world.database, world.operatorClaims, {
        printerId: 'printer-offline-02',
        labelType: 'parcel_4x6',
        documentId: 'DOC-SHIP-002',
        copies: 1
      })
    ).rejects.toMatchObject({ code: 'printer_offline' })

    // 2c: Idempotent reprint returns existing completed job
    const reprintResult = await executePrintJob(world.database, world.operatorClaims, {
      printerId: 'printer-zpl-01',
      labelType: 'parcel_4x6',
      documentId: 'DOC-SHIP-001',
      copies: 1
    })
    expect(reprintResult.status).toBe('completed')
    expect(reprintResult.isReprint).toBe(true)
  })

  it('3. Reconexión: Offline delivery event batch syncs in order upon network restoration', async () => {
    const offlineBatch = {
      events: [
        {
          commandId: 'cmd-offline-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T07:30:00Z'
        },
        {
          commandId: 'cmd-offline-02',
          kind: 'start' as const,
          stopId: world.stopId,
          occurredAt: '2026-10-31T07:45:00Z'
        },
        {
          commandId: 'cmd-offline-03',
          kind: 'deliver' as const,
          stopId: world.stopId,
          occurredAt: '2026-10-31T08:00:00Z',
          pod: {
            method: 'signature' as const,
            receivedBy: 'Encargado Almacén',
            evidence: {
              mime: 'image/png' as const,
              base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
            }
          }
        }
      ]
    }

    const syncResult = await executeOfflineReconnectionSync(world.database, world.driverClaims, offlineBatch)
    expect(syncResult.appliedCount).toBe(3)
    expect(syncResult.routeStatus).toBe('completed')
    expect(syncResult.stopStatus).toBe('delivered')
    expect(syncResult.results.every((r) => r.outcome === 'applied')).toBe(true)
  })

  it('4. Duplicado: Handles duplicate scan and idempotent replay of sync events', async () => {
    // 4a: Scan beyond expected item quantity
    const duplicateScan = await handleDuplicateScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      excessQuantity: 5
    })
    expect(duplicateScan.flaggedDuplicate).toBe(true)
    expect(duplicateScan.reason).toBe('item_already_completed')

    // 4b: Replay of identical sync event returns 'replayed' without state mutation
    const replayEvent = {
      events: [
        {
          commandId: 'cmd-replay-test-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T08:00:00Z'
        }
      ]
    }
    const firstAttempt = await executeOfflineReconnectionSync(world.database, world.driverClaims, replayEvent)
    expect(firstAttempt.results[0]!.outcome).toBe('applied')

    const secondAttempt = await executeOfflineReconnectionSync(world.database, world.driverClaims, replayEvent)
    expect(secondAttempt.results[0]!.outcome).toBe('replayed')
  })

  it('5. Dispositivo perdido: Revokes compromised device and blocks subsequent syncs', async () => {
    // 5a: Device is reported lost and session is revoked
    const revokeResult = await handleLostDeviceRevocation(world.database, world.adminClaims, {
      lostIdentityId: world.driverClaims.identityId,
      reason: 'Tablet extraviada en ruta comercial 3'
    })
    expect(revokeResult.revoked).toBe(true)
    expect(revokeResult.activeSessionsTerminated).toBeGreaterThanOrEqual(1)

    // 5b: Sync attempt from lost device is rejected
    const blockedSync = executeOfflineReconnectionSync(world.database, world.driverClaims, {
      events: [
        {
          commandId: 'cmd-lost-device-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T09:00:00Z'
        }
      ]
    })
    await expect(blockedSync).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('6. Conciliación: Inventory and fulfillment reconcile with zero discrepancy and detect real ledger tampering', async () => {
    const report = await reconcileFulfillmentAndInventory(world.database, world.adminClaims, {
      orderId: world.orderId
    })
    expect(report.isReconciled).toBe(true)
    expect(report.orderedQuantity).toBe(report.fulfilledQuantity)
    expect(report.inventoryDecremented).toBe(report.fulfilledQuantity)
    expect(report.discrepancies).toHaveLength(0)
    expect(report.ledgerConsistent).toBe(true)

    // Tamper with reservation quantity in D1 to verify real reconciliation detection
    world.sqlite.exec('UPDATE inventory_reservation_lines SET quantity = quantity + 3')
    const tamperedReport = await reconcileFulfillmentAndInventory(world.database, world.adminClaims, {
      orderId: world.orderId
    })
    expect(tamperedReport.isReconciled).toBe(false)
    expect(tamperedReport.discrepancies.length).toBeGreaterThan(0)
  })
})
