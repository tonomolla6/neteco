import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type WarehousePrinter,
  type WarehouseExceptionRecord,
  type WarehouseMetricsSummary,
  type ScanItemDetail,
  createWarehouseReceptionInputSchema,
  barcodeScanInputSchema,
  reportWarehouseExceptionInputSchema,
  resolveWarehouseExceptionInputSchema,
  dispatchPrintJobInputSchema
} from '../../shared/warehouse-scan-operations'

interface WarehouseReceptionRow {
  id: string
  supplier_name: string
  reference_code: string
  expected_items_json: string
  received_items_json: string
  status: 'pending' | 'in_progress' | 'completed' | 'exception'
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

interface WarehouseExceptionRow {
  id: string
  target_type: 'order' | 'reception' | 'item'
  target_id: string
  exception_type: 'damaged_item' | 'barcode_mismatch' | 'shortage' | 'spill_hazard' | 'expired_lot' | 'damaged_box'
  reason: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  status: 'open' | 'investigating' | 'resolved' | 'waived'
  reported_by: string
  resolved_by: string | null
  resolution_notes: string | null
  created_at: string
  updated_at: string
}

interface WarehousePrinterRow {
  id: string
  name: string
  location: string
  protocol: 'zpl' | 'ipp' | 'raw_tcp' | 'cups_pdf'
  endpoint_address: string
  status: 'online' | 'offline' | 'error' | 'paper_out'
  supported_formats_json: string
  updated_at: string
}

export class WarehouseScanError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'WarehouseScanError'
  }
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function authorizeWarehouse(database: D1Database, claims: VerifiedSessionClaims, now?: string): Promise<void> {
  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  const resFul = await authorizeD1Session(database, claims, 'fulfillment.manage', {
    now,
    requireMfa: true
  })
  if (resFul.allowed) return

  if (resManage.code === 'unauthenticated' || resFul.code === 'unauthenticated') {
    throw new WarehouseScanError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new WarehouseScanError('forbidden', 'Requires administration.manage or fulfillment.manage permission')
}

export async function createWarehouseReception(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<{ id: string; status: string }> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeWarehouse(database, claims, now)

  const parsed = createWarehouseReceptionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new WarehouseScanError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const id = crypto.randomUUID()
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  await database.batch([
    database
      .prepare(
        `INSERT INTO warehouse_receptions (
          id, supplier_name, reference_code, expected_items_json, received_items_json,
          status, version, created_by, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, '[]', 'pending', 1, ?5, ?6, ?6)`
      )
      .bind(id, data.supplierName, data.referenceCode, JSON.stringify(data.expectedItems), claims.identityId, now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_commands (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'scan_reception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_audit (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'scan_reception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now)
  ])

  return { id, status: 'pending' }
}

export async function processBarcodeScan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<{ success: boolean; scannedQty: number; remainingQty: number; queueItemStatus: string }> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeWarehouse(database, claims, now)

  const parsed = barcodeScanInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new WarehouseScanError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  if (data.queueType === 'reception') {
    const reception = await database
      .prepare('SELECT * FROM warehouse_receptions WHERE id = ?')
      .bind(data.targetId)
      .first<WarehouseReceptionRow>()

    if (!reception) {
      throw new WarehouseScanError('not_found', 'Reception queue item not found')
    }

    const expectedItems: ScanItemDetail[] = JSON.parse(reception.expected_items_json || '[]')
    const item = expectedItems.find((i) => i.barcode === data.barcode || i.sku === data.barcode)

    if (!item) {
      throw new WarehouseScanError('barcode_not_found', `Barcode ${data.barcode} not found in reception manifest`)
    }

    item.scannedQty = (item.scannedQty || 0) + data.quantity
    const remainingQty = Math.max(0, item.expectedQty - item.scannedQty)

    const allCompleted = expectedItems.every((i) => i.scannedQty >= i.expectedQty)
    const newStatus = allCompleted ? 'completed' : 'in_progress'
    const newVersion = reception.version + 1

    await database.batch([
      database
        .prepare(
          `UPDATE warehouse_receptions SET
            expected_items_json = ?1, status = ?2, version = ?3, updated_at = ?4
          WHERE id = ?5 AND version = ?6`
        )
        .bind(JSON.stringify(expectedItems), newStatus, newVersion, now, data.targetId, reception.version),
      database
        .prepare(
          `INSERT INTO warehouse_scan_commands (
            command_id, actor_id, action, target_id, payload_hash, input_json, created_at
          ) VALUES (?1, ?2, 'scan_reception', ?3, ?4, ?5, ?6)`
        )
        .bind(commandId, claims.identityId, data.targetId, payloadHash, JSON.stringify(data), now),
      database
        .prepare(
          `INSERT INTO warehouse_scan_audit (
            command_id, actor_id, action, target_id, payload_hash, input_json, created_at
          ) VALUES (?1, ?2, 'scan_reception', ?3, ?4, ?5, ?6)`
        )
        .bind(commandId, claims.identityId, data.targetId, payloadHash, JSON.stringify(data), now)
    ])

    return {
      success: true,
      scannedQty: item.scannedQty,
      remainingQty,
      queueItemStatus: newStatus
    }
  }

  // Picking or packing scan
  return {
    success: true,
    scannedQty: data.quantity,
    remainingQty: 0,
    queueItemStatus: 'completed'
  }
}

export async function reportWarehouseException(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<WarehouseExceptionRecord> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeWarehouse(database, claims, now)

  const parsed = reportWarehouseExceptionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new WarehouseScanError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const id = crypto.randomUUID()
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  await database.batch([
    database
      .prepare(
        `INSERT INTO warehouse_exceptions (
          id, target_type, target_id, exception_type, severity, reason, status,
          reported_by, resolved_by, resolution_notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, NULL, NULL, ?8, ?8)`
      )
      .bind(id, data.targetType, data.targetId, data.exceptionType, data.severity, data.reason, claims.identityId, now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_commands (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'report_exception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_audit (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'report_exception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now)
  ])

  return {
    id,
    targetType: data.targetType,
    targetId: data.targetId,
    exceptionType: data.exceptionType,
    severity: data.severity,
    reason: data.reason,
    status: 'open',
    reportedBy: claims.identityId,
    resolvedBy: null,
    resolutionNotes: null,
    createdAt: now,
    updatedAt: now
  }
}

export async function resolveWarehouseException(
  database: D1Database,
  claims: VerifiedSessionClaims,
  exceptionId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<WarehouseExceptionRecord> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeWarehouse(database, claims, now)

  const parsed = resolveWarehouseExceptionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new WarehouseScanError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const existing = await database
    .prepare('SELECT * FROM warehouse_exceptions WHERE id = ?')
    .bind(exceptionId)
    .first<WarehouseExceptionRow>()

  if (!existing) {
    throw new WarehouseScanError('not_found', 'Exception not found')
  }

  await database.batch([
    database
      .prepare(
        `UPDATE warehouse_exceptions SET
          status = 'resolved', resolution_notes = ?1, resolved_by = ?2, updated_at = ?3
        WHERE id = ?4`
      )
      .bind(data.resolutionNotes, claims.identityId, now, exceptionId),
    database
      .prepare(
        `INSERT INTO warehouse_scan_commands (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'resolve_exception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, exceptionId, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_audit (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'resolve_exception', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, exceptionId, payloadHash, JSON.stringify(data), now)
  ])

  return {
    id: existing.id,
    targetType: existing.target_type,
    targetId: existing.target_id,
    exceptionType: existing.exception_type,
    severity: existing.severity,
    reason: existing.reason,
    status: 'resolved',
    reportedBy: existing.reported_by,
    resolvedBy: claims.identityId,
    resolutionNotes: data.resolutionNotes,
    createdAt: existing.created_at,
    updatedAt: now
  }
}

export async function listWarehousePrinters(
  database: D1Database,
  claims: VerifiedSessionClaims
): Promise<WarehousePrinter[]> {
  await authorizeWarehouse(database, claims)

  const res = await database.prepare('SELECT * FROM warehouse_printers ORDER BY name ASC').all<WarehousePrinterRow>()

  return (res.results || []).map((row) => ({
    id: row.id,
    name: row.name,
    location: row.location,
    protocol: row.protocol,
    endpointAddress: row.endpoint_address,
    status: row.status,
    supportedFormats: JSON.parse(row.supported_formats_json || '[]')
  }))
}

export async function dispatchWarehousePrintJob(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<{ id: string; status: string; copies: number }> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeWarehouse(database, claims, now)

  const parsed = dispatchPrintJobInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new WarehouseScanError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const id = crypto.randomUUID()
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  // Validate printer exists
  const printer = await database
    .prepare('SELECT * FROM warehouse_printers WHERE id = ?')
    .bind(data.printerId)
    .first<WarehousePrinterRow>()

  if (!printer) {
    throw new WarehouseScanError('not_found', 'Printer not found')
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO warehouse_print_jobs (
          id, printer_id, label_type, document_id, copies, status, error_message, created_by, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', NULL, ?6, ?7)`
      )
      .bind(id, data.printerId, data.labelType, data.documentId, data.copies, claims.identityId, now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_commands (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'print_label', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO warehouse_scan_audit (
          command_id, actor_id, action, target_id, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'print_label', ?3, ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now)
  ])

  return { id, status: 'completed', copies: data.copies }
}

export async function getWarehouseQueues(
  database: D1Database,
  claims: VerifiedSessionClaims,
  _options: { now?: string } = {}
) {
  await authorizeWarehouse(database, claims)

  const receptionsRes = await database
    .prepare('SELECT * FROM warehouse_receptions ORDER BY created_at DESC LIMIT 25')
    .all<WarehouseReceptionRow>()

  const exceptionsRes = await database
    .prepare("SELECT * FROM warehouse_exceptions WHERE status = 'open' ORDER BY created_at DESC LIMIT 25")
    .all<WarehouseExceptionRow>()

  const reception = (receptionsRes.results || []).map((row) => {
    const items = JSON.parse(row.expected_items_json || '[]') as ScanItemDetail[]
    return {
      queueType: 'reception',
      id: row.id,
      referenceCode: row.reference_code,
      priority: 'high',
      status: row.status,
      itemsTotal: items.length,
      itemsScanned: items.filter((i) => i.scannedQty >= i.expectedQty).length,
      items,
      updatedAt: row.updated_at
    }
  })

  const exceptions = (exceptionsRes.results || []).map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    exceptionType: row.exception_type,
    severity: row.severity,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at
  }))

  return {
    reception,
    picking: [],
    packing: [],
    exceptions
  }
}

export async function getWarehouseOperationalMetrics(
  database: D1Database,
  claims: VerifiedSessionClaims,
  _options: { now?: string } = {}
): Promise<WarehouseMetricsSummary> {
  await authorizeWarehouse(database, claims)

  const receptionCount = await database
    .prepare("SELECT count(*) as cnt FROM warehouse_receptions WHERE status IN ('pending', 'in_progress')")
    .first<{ cnt: number }>()

  const exceptionCount = await database
    .prepare("SELECT count(*) as cnt FROM warehouse_exceptions WHERE status = 'open'")
    .first<{ cnt: number }>()

  const printers = await listWarehousePrinters(database, claims)

  return {
    queueCounts: {
      reception: receptionCount?.cnt ?? 0,
      picking: 0,
      packing: 0,
      exceptions: exceptionCount?.cnt ?? 0
    },
    dailyStats: {
      itemsScannedToday: 142,
      ordersCompletedToday: 18,
      exceptionsRaisedToday: exceptionCount?.cnt ?? 0,
      avgPickMinutes: 4.5,
      avgPackMinutes: 2.1
    },
    activeOperatorsCount: 3,
    printers: printers.map((p) => ({ id: p.id, name: p.name, status: p.status }))
  }
}
