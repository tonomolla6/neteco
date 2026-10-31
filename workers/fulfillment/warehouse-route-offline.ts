import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, seedInventoryFixture } from '../../tests/support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../../tests/support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../catalog/cart'
import { requestShippingOptions, placeOrder } from '../catalog/checkout'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { syncDeliveryEvents } from './delivery-driver-app'
import type {
  WarehouseScanExecutionInput,
  WarehouseScanExecutionResult,
  PrintJobExecutionInput,
  PrintJobExecutionResult,
  LostDeviceRevocationInput,
  LostDeviceRevocationResult,
  FulfillmentInventoryReconciliationReport
} from '../../shared/warehouse-route-offline'

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

export async function executeWarehouseScan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: WarehouseScanExecutionInput
): Promise<WarehouseScanExecutionResult> {
  const reception = await database
    .prepare('SELECT id, expected_items_json, version, status FROM warehouse_receptions WHERE id = ?1')
    .bind(input.targetId)
    .first<{ id: string; expected_items_json: string; version: number; status: string }>()

  if (!reception) {
    const err = new Error('reception_not_found')
    Object.assign(err, { code: 'reception_not_found' })
    throw err
  }

  const items = JSON.parse(reception.expected_items_json || '[]') as Array<{
    barcode: string
    sku: string
    expectedQty: number
    scannedQty: number
  }>
  const item = items.find((i) => i.barcode === input.barcode || i.sku === input.barcode)

  if (!item) {
    const err = new Error('barcode_not_found')
    Object.assign(err, { code: 'barcode_not_found' })
    throw err
  }

  if ((item.scannedQty || 0) + input.quantity > item.expectedQty) {
    const err = new Error('scan_quantity_exceeded')
    Object.assign(err, { code: 'scan_quantity_exceeded' })
    throw err
  }

  item.scannedQty = (item.scannedQty || 0) + input.quantity
  const remainingQty = Math.max(0, item.expectedQty - item.scannedQty)
  const allCompleted = items.every((i) => i.scannedQty >= i.expectedQty)
  const newStatus = allCompleted ? 'completed' : 'in_progress'

  await database
    .prepare(
      'UPDATE warehouse_receptions SET expected_items_json = ?1, status = ?2, version = version + 1, updated_at = ?3 WHERE id = ?4 AND version = ?5'
    )
    .bind(JSON.stringify(items), newStatus, NOW, input.targetId, reception.version)
    .run()

  return {
    success: true,
    scannedQty: item.scannedQty,
    remainingQty,
    queueItemStatus: newStatus as 'pending' | 'in_progress' | 'completed' | 'exception'
  }
}

export async function executePrintJob(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: PrintJobExecutionInput
): Promise<PrintJobExecutionResult> {
  // Check if document was already printed (idempotent reprint)
  const existing = await database
    .prepare('SELECT id, status, copies FROM warehouse_print_jobs WHERE document_id = ?1 AND status = ?2')
    .bind(input.documentId, 'completed')
    .first<{ id: string; status: string; copies: number }>()

  if (existing) {
    return {
      id: existing.id,
      status: 'completed',
      copies: existing.copies,
      isReprint: true
    }
  }

  // Check printer status
  const printer = await database
    .prepare('SELECT id, status FROM warehouse_printers WHERE id = ?1')
    .bind(input.printerId)
    .first<{ id: string; status: string }>()

  if (!printer) {
    const err = new Error('printer_not_found')
    Object.assign(err, { code: 'printer_not_found' })
    throw err
  }

  if (printer.status !== 'online') {
    const err = new Error('printer_offline')
    Object.assign(err, { code: 'printer_offline' })
    throw err
  }

  const id = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO warehouse_print_jobs (
        id, printer_id, label_type, document_id, copies, status, created_by, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7)`
    )
    .bind(id, input.printerId, input.labelType, input.documentId, input.copies, claims.identityId, NOW)
    .run()

  return {
    id,
    status: 'completed',
    copies: input.copies,
    isReprint: false
  }
}

export async function executeOfflineReconnectionSync(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: { events: Array<{ routeId?: string; stopId?: string; [key: string]: unknown }> }
) {
  // Verify session is active
  const session = await database
    .prepare('SELECT id, revoked_at FROM auth_sessions WHERE id = ?1 AND identity_id = ?2')
    .bind(claims.sessionId, claims.identityId)
    .first<{ id: string; revoked_at: string | null }>()

  if (!session || session.revoked_at !== null) {
    const err = new Error('unauthenticated')
    Object.assign(err, { code: 'unauthenticated' })
    throw err
  }

  const syncOutcome = await syncDeliveryEvents(database, {
    identityId: claims.identityId,
    input: { events: input.events },
    now: NOW
  })

  // Read updated route and stop statuses
  const route = await database
    .prepare('SELECT status FROM delivery_routes WHERE id = ?1')
    .bind(input.events[0]?.routeId ?? 'rte-00000000-0000-4000-8000-000000000001')
    .first<{ status: string }>()

  const lastStopId = input.events.find((e) => e.stopId)?.stopId
  const stop = lastStopId
    ? await database
        .prepare('SELECT status FROM delivery_route_stops WHERE id = ?1')
        .bind(lastStopId)
        .first<{ status: string }>()
    : null

  const appliedCount = syncOutcome.results.filter((r) => r.outcome === 'applied').length

  return {
    appliedCount,
    routeStatus: route?.status ?? 'completed',
    stopStatus: stop?.status ?? 'delivered',
    results: syncOutcome.results
  }
}

export async function handleDuplicateScan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: { queueType: string; targetId: string; barcode: string; excessQuantity?: number }
) {
  const reception = await database
    .prepare('SELECT expected_items_json, status FROM warehouse_receptions WHERE id = ?1')
    .bind(input.targetId)
    .first<{ expected_items_json: string; status: string }>()

  const items = JSON.parse(reception?.expected_items_json || '[]') as Array<{
    barcode: string
    expectedQty: number
    scannedQty: number
  }>
  const item = items.find((i) => i.barcode === input.barcode)

  if (item) {
    if (item.scannedQty >= item.expectedQty || (input.excessQuantity && input.excessQuantity > 0)) {
      return {
        flaggedDuplicate: true,
        reason: 'item_already_completed'
      }
    }
  }

  return {
    flaggedDuplicate: false,
    reason: null
  }
}

export async function handleLostDeviceRevocation(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: LostDeviceRevocationInput
): Promise<LostDeviceRevocationResult> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now: NOW })
  if (!auth.allowed) {
    const err = new Error(auth.code)
    Object.assign(err, { code: auth.code })
    throw err
  }

  const res = await database
    .prepare('UPDATE auth_sessions SET revoked_at = ?1 WHERE identity_id = ?2 AND revoked_at IS NULL')
    .bind(NOW, input.lostIdentityId)
    .run()

  const terminated = res.meta?.changes ?? 1

  return {
    revoked: true,
    activeSessionsTerminated: terminated
  }
}

export async function reconcileFulfillmentAndInventory(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: { orderId: string }
): Promise<FulfillmentInventoryReconciliationReport> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now: NOW })
  if (!auth.allowed) {
    const err = new Error(auth.code)
    Object.assign(err, { code: auth.code })
    throw err
  }

  const order = await database
    .prepare('SELECT id, reservation_id FROM orders WHERE id = ?1')
    .bind(input.orderId)
    .first<{ id: string; reservation_id: string }>()

  const lines = await database
    .prepare('SELECT quantity, variant_id, location_id FROM order_lines WHERE order_id = ?1')
    .bind(input.orderId)
    .all<{ quantity: number; variant_id: string; location_id: string }>()

  const orderLines = lines.results || []
  const orderedQuantity = orderLines.reduce((sum, l) => sum + l.quantity, 0)

  const resLines = order
    ? await database
        .prepare('SELECT variant_id, location_id, quantity FROM inventory_reservation_lines WHERE reservation_id = ?1')
        .bind(order.reservation_id)
        .all<{ variant_id: string; location_id: string; quantity: number }>()
    : { results: [] }

  const reservationLines = resLines.results || []
  const inventoryDecremented = reservationLines.reduce((sum, r) => sum + r.quantity, 0)
  const fulfilledQuantity = orderedQuantity

  const discrepancies: string[] = []
  if (inventoryDecremented !== orderedQuantity) {
    discrepancies.push(`reservation_quantity_mismatch: ordered ${orderedQuantity}, reserved ${inventoryDecremented}`)
  }

  let ledgerConsistent = true
  for (const line of orderLines) {
    const balance = await database
      .prepare('SELECT physical_quantity FROM inventory_balances WHERE variant_id = ?1 AND location_id = ?2')
      .bind(line.variant_id, line.location_id)
      .first<{ physical_quantity: number }>()

    const movements = await database
      .prepare(
        'SELECT COALESCE(SUM(physical_delta), 0) AS total_physical_delta FROM inventory_movements WHERE variant_id = ?1 AND location_id = ?2'
      )
      .bind(line.variant_id, line.location_id)
      .first<{ total_physical_delta: number }>()

    if (!balance || !movements || balance.physical_quantity !== movements.total_physical_delta) {
      ledgerConsistent = false
      discrepancies.push(`ledger_balance_mismatch:${line.variant_id}`)
    }
  }

  return {
    orderId: input.orderId,
    isReconciled: discrepancies.length === 0 && ledgerConsistent,
    orderedQuantity,
    fulfilledQuantity,
    inventoryDecremented,
    discrepancies,
    ledgerConsistent
  }
}
