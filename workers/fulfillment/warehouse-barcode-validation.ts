import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  InventoryPlanningError,
  authorizePlanning,
  canonicalJson,
  isUuid,
  mapPlanningDbError,
  planningNow,
  recordCommandStatement,
  runIdempotent,
  sha256Hex,
  type PlanningOptions
} from '../catalog/inventory-planning-core'
import { closeShortInputSchema, createScanTaskInputSchema, scanInputSchema } from '../../shared/inventory-planning'

export type ScanRejectCode = 'barcode_unknown' | 'sku_not_in_task' | 'quantity_exceeds_expected'

export interface ScanResult {
  outcome: 'accepted' | 'exception' | 'rejected'
  code: ScanRejectCode | null
  taskStatus: 'open' | 'completed' | 'completed_with_exceptions'
  variantId: string | null
  sku: string | null
  scannedQuantity: number | null
  expectedQuantity: number | null
  remainingQuantity: number | null
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new InventoryPlanningError('invalid_input')
  return parsed.data as T
}

export async function createScanTask(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{
    stage: string
    orderId?: string
    reference?: string
    lines?: { sku: string; quantity: number }[]
  }>(createScanTaskInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'create_task', ...data }))
  return runIdempotent(database, { commandId, scope: 'scan', payloadHash }, async () => {
    let lines: { variantId: string; sku: string; quantity: number }[]
    let reference: string
    let orderId: string | null = null
    if (typeof data.orderId === 'string') {
      const { results } = await database
        .prepare(
          `SELECT l.variant_id variantId, v.sku, SUM(l.quantity) quantity FROM order_lines l
           JOIN variants v ON v.id=l.variant_id WHERE l.order_id=?1 GROUP BY l.variant_id, v.sku ORDER BY v.sku`
        )
        .bind(data.orderId)
        .all<{ variantId: string; sku: string; quantity: number }>()
      if (!results.length) throw new InventoryPlanningError('not_found')
      lines = results
      reference = `ORDER ${data.orderId}`.slice(0, 100)
      orderId = data.orderId
    } else {
      const skus = data.lines!.map((l) => l.sku)
      if (new Set(skus).size !== skus.length) throw new InventoryPlanningError('invalid_input')
      const { results } = await database
        .prepare(`SELECT id, sku FROM variants WHERE sku IN (${skus.map((_, i) => `?${i + 1}`).join(',')})`)
        .bind(...skus)
        .all<{ id: string; sku: string }>()
      const bySku = new Map(results.map((r) => [r.sku, r.id]))
      if (bySku.size !== skus.length) throw new InventoryPlanningError('invalid_input')
      lines = data.lines!.map((l) => ({
        variantId: bySku.get(l.sku)!,
        sku: l.sku,
        quantity: l.quantity
      }))
      reference = data.reference!
    }
    const id = crypto.randomUUID()
    const response = { id, stage: data.stage as string, status: 'open', version: 1, lines: lines.length }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `INSERT INTO warehouse_scan_tasks(id,stage,reference,order_id,status,version,created_by,created_at,updated_at)
           VALUES(?1,?2,?3,?4,'open',1,?5,?6,?6)`
        )
        .bind(id, data.stage, reference, orderId, claims.identityId, now),
      ...lines.map((l) =>
        database
          .prepare(
            `INSERT INTO warehouse_scan_task_lines(task_id,variant_id,sku,expected_quantity) VALUES(?1,?2,?3,?4)`
          )
          .bind(id, l.variantId, l.sku, l.quantity)
      ),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'scan',
        action: 'create_task',
        targetId: id,
        payloadHash,
        response,
        now
      })
    ])
    return response
  })
}

export async function scanBarcode(
  database: D1Database,
  claims: VerifiedSessionClaims,
  taskId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
): Promise<ScanResult> {
  await authorizePlanning(database, claims, 'inventory.write', options)
  if (!isUuid(taskId) || !isUuid(commandId)) throw new InventoryPlanningError('invalid_input')
  const data = parse<{
    barcode: string
    quantity: number
    exception?: { reason: string; note: string }
  }>(scanInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'scan', taskId, ...data }))

  const replay = async () => {
    const prior = await database
      .prepare('SELECT payload_hash, response_json FROM warehouse_scan_events WHERE command_id=?1')
      .bind(commandId)
      .first<{ payload_hash: string; response_json: string }>()
    if (!prior) return null
    if (prior.payload_hash !== payloadHash) throw new InventoryPlanningError('idempotency_conflict')
    return JSON.parse(prior.response_json) as ScanResult
  }
  const stored = await replay()
  if (stored) return stored
  try {
    const task = await database
      .prepare('SELECT status FROM warehouse_scan_tasks WHERE id=?1')
      .bind(taskId)
      .first<{ status: ScanResult['taskStatus'] }>()
    if (!task) throw new InventoryPlanningError('not_found')
    if (task.status !== 'open') throw new InventoryPlanningError('invalid_state')

    // Normal scans resolve by EAN/GTIN only; a hand-typed SKU requires exception mode.
    const variant = await database
      .prepare(
        data.exception
          ? 'SELECT id, sku FROM variants WHERE ean=?1 OR gtin=?1 OR sku=?1 LIMIT 1'
          : 'SELECT id, sku FROM variants WHERE ean=?1 OR gtin=?1 LIMIT 1'
      )
      .bind(data.barcode)
      .first<{ id: string; sku: string }>()
    const line = variant
      ? await database
          .prepare(
            `SELECT expected_quantity expected, scanned_quantity scanned, version FROM warehouse_scan_task_lines
             WHERE task_id=?1 AND variant_id=?2`
          )
          .bind(taskId, variant.id)
          .first<{ expected: number; scanned: number; version: number }>()
      : null
    let reject: ScanRejectCode | null = null
    if (!variant) reject = 'barcode_unknown'
    else if (!line) reject = 'sku_not_in_task'
    else if (line.scanned + data.quantity > line.expected) reject = 'quantity_exceeds_expected'

    await authorizePlanning(database, claims, 'inventory.write', options)
    const eventId = crypto.randomUUID()
    const insertEvent = (result: ScanResult, guarded: boolean) => {
      const base = `INSERT INTO warehouse_scan_events(id,command_id,task_id,actor_id,payload_hash,barcode,variant_id,quantity,outcome,reason_code,exception_note,response_json,created_at)`
      const binds = [
        eventId,
        commandId,
        taskId,
        claims.identityId,
        payloadHash,
        data.barcode,
        variant?.id ?? null,
        data.quantity,
        result.outcome,
        result.code ?? (result.outcome === 'exception' ? data.exception!.reason : null),
        data.exception?.note ?? null,
        JSON.stringify(result),
        now
      ]
      return guarded
        ? database
            .prepare(
              `${base} SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13
               WHERE changes() > 0`
            )
            .bind(...binds)
        : database.prepare(`${base} VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`).bind(...binds)
    }
    if (reject) {
      const result: ScanResult = {
        outcome: 'rejected',
        code: reject,
        taskStatus: 'open',
        variantId: variant?.id ?? null,
        sku: variant?.sku ?? null,
        scannedQuantity: line?.scanned ?? null,
        expectedQuantity: line?.expected ?? null,
        remainingQuantity: line ? line.expected - line.scanned : null
      }
      await database.batch([insertEvent(result, false)])
      return result
    }
    const scanned = line!.scanned + data.quantity
    const completes =
      (await database
        .prepare(
          `SELECT COUNT(*) n FROM warehouse_scan_task_lines WHERE task_id=?1 AND variant_id<>?2 AND scanned_quantity<expected_quantity`
        )
        .bind(taskId, variant!.id)
        .first<{ n: number }>())!.n === 0 && scanned === line!.expected
    const result: ScanResult = {
      outcome: data.exception ? 'exception' : 'accepted',
      code: null,
      taskStatus: completes ? 'completed' : 'open',
      variantId: variant!.id,
      sku: variant!.sku,
      scannedQuantity: scanned,
      expectedQuantity: line!.expected,
      remainingQuantity: line!.expected - scanned
    }
    await database.batch([
      database
        .prepare(
          `UPDATE warehouse_scan_task_lines SET scanned_quantity=scanned_quantity+?3, version=version+1
           WHERE task_id=?1 AND variant_id=?2 AND version=?4`
        )
        .bind(taskId, variant!.id, data.quantity, line!.version),
      insertEvent(result, true),
      database
        .prepare(
          `UPDATE warehouse_scan_tasks SET status='completed', version=version+1, updated_at=?2
           WHERE id=?1 AND status='open' AND NOT EXISTS(SELECT 1 FROM warehouse_scan_task_lines WHERE task_id=?1 AND scanned_quantity<expected_quantity)
             AND EXISTS(SELECT 1 FROM warehouse_scan_events WHERE command_id=?3)`
        )
        .bind(taskId, now, commandId)
    ])
    const written = await database
      .prepare('SELECT 1 AS ok FROM warehouse_scan_events WHERE command_id=?1')
      .bind(commandId)
      .first()
    if (!written) throw new InventoryPlanningError('version_conflict')
    return result
  } catch (cause) {
    const mapped = mapPlanningDbError(cause)
    if (mapped.code === 'idempotency_conflict' || mapped.code === 'service_unavailable') {
      const winner = await replay().catch(() => null)
      if (winner) return winner
    }
    throw mapped
  }
}

export async function closeScanTaskShort(
  database: D1Database,
  claims: VerifiedSessionClaims,
  taskId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ expectedVersion: number; note: string }>(closeShortInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'close_short', taskId, ...data }))
  return runIdempotent(database, { commandId, scope: 'scan', payloadHash }, async () => {
    const task = await database
      .prepare('SELECT status, version FROM warehouse_scan_tasks WHERE id=?1')
      .bind(taskId)
      .first<{ status: string; version: number }>()
    if (!task) throw new InventoryPlanningError('not_found')
    if (task.status !== 'open') throw new InventoryPlanningError('invalid_state')
    if (task.version !== data.expectedVersion) throw new InventoryPlanningError('version_conflict')
    const { results } = await database
      .prepare(
        `SELECT sku, expected_quantity - scanned_quantity AS missing FROM warehouse_scan_task_lines
         WHERE task_id=?1 AND scanned_quantity<expected_quantity ORDER BY sku`
      )
      .bind(taskId)
      .all<{ sku: string; missing: number }>()
    if (!results.length) throw new InventoryPlanningError('no_change')
    const response = {
      id: taskId,
      status: 'completed_with_exceptions',
      version: data.expectedVersion + 1,
      shortages: results,
      note: data.note
    }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE warehouse_scan_tasks SET status='completed_with_exceptions', version=version+1, updated_at=?3
           WHERE id=?1 AND version=?2 AND status='open'`
        )
        .bind(taskId, data.expectedVersion, now),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'scan',
        action: 'close_short',
        targetId: taskId,
        payloadHash,
        response,
        now,
        afterChange: true
      })
    ])
    const stored = await database
      .prepare('SELECT 1 AS ok FROM inventory_planning_commands WHERE command_id=?1')
      .bind(commandId)
      .first()
    if (!stored) throw new InventoryPlanningError('version_conflict')
    return response
  })
}

export async function readScanTask(
  database: D1Database,
  claims: VerifiedSessionClaims,
  taskId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.read', options)
  if (!isUuid(taskId)) throw new InventoryPlanningError('not_found')
  const task = await database
    .prepare(
      `SELECT id, stage, reference, order_id orderId, status, version, created_at createdAt FROM warehouse_scan_tasks WHERE id=?1`
    )
    .bind(taskId)
    .first<Record<string, unknown>>()
  if (!task) throw new InventoryPlanningError('not_found')
  const [lines, metrics] = await Promise.all([
    database
      .prepare(
        `SELECT variant_id variantId, sku, expected_quantity expectedQuantity, scanned_quantity scannedQuantity
         FROM warehouse_scan_task_lines WHERE task_id=?1 ORDER BY sku`
      )
      .bind(taskId)
      .all(),
    database
      .prepare(
        `SELECT COALESCE(SUM(outcome='accepted'),0) accepted, COALESCE(SUM(outcome='exception'),0) exceptions,
                COALESCE(SUM(outcome='rejected'),0) rejected FROM warehouse_scan_events WHERE task_id=?1`
      )
      .bind(taskId)
      .first<{ accepted: number; exceptions: number; rejected: number }>()
  ])
  return { ...task, lines: lines.results, metrics }
}

export async function listScanTasks(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: PlanningOptions & { stage?: string; status?: string; limit?: number }
) {
  await authorizePlanning(database, claims, 'inventory.read', options)
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100)
  const { results } = await database
    .prepare(
      `SELECT t.id, t.stage, t.reference, t.status, t.version, t.created_at createdAt,
              (SELECT COALESCE(SUM(expected_quantity),0) FROM warehouse_scan_task_lines l WHERE l.task_id=t.id) expectedQuantity,
              (SELECT COALESCE(SUM(scanned_quantity),0) FROM warehouse_scan_task_lines l WHERE l.task_id=t.id) scannedQuantity
       FROM warehouse_scan_tasks t WHERE (?1 IS NULL OR t.stage=?1) AND (?2 IS NULL OR t.status=?2)
       ORDER BY t.created_at DESC, t.id LIMIT ?3`
    )
    .bind(options?.stage ?? null, options?.status ?? null, limit)
    .all()
  return results
}
