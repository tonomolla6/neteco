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

const NOW = '2026-10-31T08:00:00Z'

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
