import {
  normalizeCostCenter,
  normalizePoReference,
  type OrderProcurementDetails,
  type OrderProcurementEvent,
  type OrderInvoiceProcurementView,
  type ProcurementApprovalStatus
} from '../../shared/order-procurement-approvals'
import { csvCell } from '../../server/utils/csv'

export interface AssignProcurementInput {
  orderId: string
  purchaseOrderReference?: string | null
  costCenter?: string | null
  approvalThresholdCents?: number | null
  now: string
}

export interface ReviewProcurementInput {
  orderId: string
  action: 'approve' | 'reject'
  expectedVersion: number
  actorId: string
  rejectionReason?: string | null
  notes?: string | null
  now: string
}

export async function assignOrderProcurementDetails(
  database: D1Database,
  input: AssignProcurementInput
): Promise<OrderProcurementDetails> {
  const po = normalizePoReference(input.purchaseOrderReference)
  const cc = normalizeCostCenter(input.costCenter)

  const order = await database
    .prepare('SELECT total_gross_cents FROM orders WHERE id = ?1')
    .bind(input.orderId)
    .first<{ total_gross_cents: number }>()

  if (!order) {
    throw new Error('order_not_found')
  }

  const threshold = input.approvalThresholdCents ?? null
  const requiresApproval = threshold !== null && order.total_gross_cents > threshold
  const approvalStatus: ProcurementApprovalStatus = requiresApproval ? 'pending_approval' : 'not_required'

  const existing = await database
    .prepare('SELECT * FROM order_procurement_approvals WHERE order_id = ?1')
    .bind(input.orderId)
    .first<{
      purchase_order_reference: string | null
      cost_center: string | null
      approval_status: ProcurementApprovalStatus
      requires_approval: number
      approval_threshold_cents: number | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (existing) {
    // If idempotent replay
    if (
      existing.purchase_order_reference === po &&
      existing.cost_center === cc &&
      existing.approval_threshold_cents === threshold
    ) {
      return getOrderProcurementDetails(database, input.orderId) as Promise<OrderProcurementDetails>
    }

    const nextVersion = existing.version + 1
    await database.batch([
      database
        .prepare(
          `
          UPDATE order_procurement_approvals
          SET purchase_order_reference = ?1,
              cost_center = ?2,
              approval_status = ?3,
              requires_approval = ?4,
              approval_threshold_cents = ?5,
              version = ?6,
              updated_at = ?7
          WHERE order_id = ?8 AND version = ?9
        `
        )
        .bind(
          po,
          cc,
          approvalStatus,
          requiresApproval ? 1 : 0,
          threshold,
          nextVersion,
          input.now,
          input.orderId,
          existing.version
        ),
      database
        .prepare(
          `
          INSERT INTO order_procurement_events (id, order_id, event_type, actor_id, actor_type, notes, created_at)
          VALUES (?1, ?2, ?3, 'system', 'system', ?4, ?5)
        `
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          requiresApproval ? 'approval_requested' : 'cost_center_assigned',
          `Asignado PO: ${po ?? 'N/A'}, CC: ${cc ?? 'N/A'}`,
          input.now
        ),
      database
        .prepare(
          `
          INSERT INTO order_invoice_procurement_metadata (order_id, purchase_order_reference, cost_center, visible_on_invoice, created_at)
          VALUES (?1, ?2, ?3, 1, ?4)
          ON CONFLICT(order_id) DO UPDATE SET
            purchase_order_reference = excluded.purchase_order_reference,
            cost_center = excluded.cost_center
        `
        )
        .bind(input.orderId, po, cc, input.now)
    ])
  } else {
    await database.batch([
      database
        .prepare(
          `
          INSERT INTO order_procurement_approvals (
            order_id, purchase_order_reference, cost_center, approval_status,
            requires_approval, approval_threshold_cents, version, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
        `
        )
        .bind(input.orderId, po, cc, approvalStatus, requiresApproval ? 1 : 0, threshold, input.now),
      database
        .prepare(
          `
          INSERT INTO order_procurement_events (id, order_id, event_type, actor_id, actor_type, notes, created_at)
          VALUES (?1, ?2, ?3, 'system', 'system', ?4, ?5)
        `
        )
        .bind(
          crypto.randomUUID(),
          input.orderId,
          requiresApproval ? 'approval_requested' : 'submitted',
          requiresApproval ? `Requiere aprobación: supera umbral de ${threshold} céntimos` : 'Asignación directa',
          input.now
        ),
      database
        .prepare(
          `
          INSERT INTO order_invoice_procurement_metadata (order_id, purchase_order_reference, cost_center, visible_on_invoice, created_at)
          VALUES (?1, ?2, ?3, 1, ?4)
          ON CONFLICT(order_id) DO UPDATE SET
            purchase_order_reference = excluded.purchase_order_reference,
            cost_center = excluded.cost_center
        `
        )
        .bind(input.orderId, po, cc, input.now)
    ])
  }

  const details = await getOrderProcurementDetails(database, input.orderId)
  if (!details) throw new Error('procurement_save_failed')
  return details
}

export async function reviewOrderProcurementApproval(
  database: D1Database,
  input: ReviewProcurementInput
): Promise<OrderProcurementDetails> {
  const existing = await database
    .prepare('SELECT * FROM order_procurement_approvals WHERE order_id = ?1')
    .bind(input.orderId)
    .first<{
      version: number
      approval_status: ProcurementApprovalStatus
    }>()

  if (!existing) {
    throw new Error('procurement_not_found')
  }

  if (existing.version !== input.expectedVersion) {
    throw new Error('conflict: expected version mismatch')
  }

  const nextVersion = existing.version + 1
  const isApproved = input.action === 'approve'
  const newStatus: ProcurementApprovalStatus = isApproved ? 'approved' : 'rejected'

  if (!isApproved && (!input.rejectionReason || !input.rejectionReason.trim())) {
    throw new Error('rejection_reason_required')
  }

  await database.batch([
    database
      .prepare(
        `
        UPDATE order_procurement_approvals
        SET approval_status = ?1,
            approved_by = ?2,
            approved_at = ?3,
            rejected_by = ?4,
            rejected_at = ?5,
            rejection_reason = ?6,
            approval_notes = ?7,
            version = ?8,
            updated_at = ?9
        WHERE order_id = ?10 AND version = ?11
      `
      )
      .bind(
        newStatus,
        isApproved ? input.actorId : null,
        isApproved ? input.now : null,
        !isApproved ? input.actorId : null,
        !isApproved ? input.now : null,
        !isApproved ? (input.rejectionReason?.trim() ?? null) : null,
        input.notes?.trim() ?? null,
        nextVersion,
        input.now,
        input.orderId,
        existing.version
      ),
    database
      .prepare(
        `
        INSERT INTO order_procurement_events (id, order_id, event_type, actor_id, actor_type, notes, created_at)
        VALUES (?1, ?2, ?3, ?4, 'admin', ?5, ?6)
      `
      )
      .bind(
        crypto.randomUUID(),
        input.orderId,
        isApproved ? 'approved' : 'rejected',
        input.actorId,
        isApproved ? (input.notes ?? 'Aprobado') : (input.rejectionReason ?? 'Rechazado'),
        input.now
      )
  ])

  const details = await getOrderProcurementDetails(database, input.orderId)
  if (!details) throw new Error('procurement_update_failed')
  if (details.version !== nextVersion) {
    throw new Error('conflict: expected version mismatch')
  }
  return details
}

export async function getOrderProcurementDetails(
  database: D1Database,
  orderId: string
): Promise<OrderProcurementDetails | null> {
  const row = await database
    .prepare('SELECT * FROM order_procurement_approvals WHERE order_id = ?1')
    .bind(orderId)
    .first<{
      order_id: string
      purchase_order_reference: string | null
      cost_center: string | null
      approval_status: ProcurementApprovalStatus
      requires_approval: number
      approval_threshold_cents: number | null
      approved_by: string | null
      approved_at: string | null
      rejected_by: string | null
      rejected_at: string | null
      rejection_reason: string | null
      approval_notes: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  const events = await database
    .prepare(
      `
      SELECT id, order_id as orderId, event_type as eventType, actor_id as actorId,
             actor_type as actorType, notes, created_at as createdAt
      FROM order_procurement_events
      WHERE order_id = ?1
      ORDER BY created_at ASC
    `
    )
    .bind(orderId)
    .all<OrderProcurementEvent>()

  return {
    orderId: row.order_id,
    purchaseOrderReference: row.purchase_order_reference,
    costCenter: row.cost_center,
    approvalStatus: row.approval_status,
    requiresApproval: row.requires_approval === 1,
    approvalThresholdCents: row.approval_threshold_cents,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    approvalNotes: row.approval_notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events: events.results ?? []
  }
}

export async function getOrderInvoiceProcurementView(
  database: D1Database,
  orderId: string
): Promise<OrderInvoiceProcurementView | null> {
  const row = await database
    .prepare('SELECT * FROM order_invoice_procurement_metadata WHERE order_id = ?1')
    .bind(orderId)
    .first<{
      order_id: string
      invoice_id: string | null
      purchase_order_reference: string | null
      cost_center: string | null
      visible_on_invoice: number
      exported_at: string | null
      created_at: string
    }>()

  if (!row) return null

  return {
    orderId: row.order_id,
    invoiceId: row.invoice_id,
    purchaseOrderReference: row.purchase_order_reference,
    costCenter: row.cost_center,
    visibleOnInvoice: row.visible_on_invoice === 1,
    exportedAt: row.exported_at,
    createdAt: row.created_at
  }
}

export async function exportOrderProcurementCsv(database: D1Database): Promise<string> {
  const rows = await database
    .prepare(
      `
      SELECT p.order_id as orderId,
             COALESCE(p.purchase_order_reference, '') as purchaseOrderReference,
             COALESCE(p.cost_center, '') as costCenter,
             p.approval_status as approvalStatus,
             COALESCE(p.approved_by, '') as approvedBy,
             COALESCE(p.approved_at, '') as approvedAt,
             o.total_gross_cents as totalGrossCents,
             COALESCE(m.visible_on_invoice, 1) as visibleOnInvoice
      FROM order_procurement_approvals p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN order_invoice_procurement_metadata m ON m.order_id = p.order_id
      ORDER BY p.created_at DESC
    `
    )
    .all<{
      orderId: string
      purchaseOrderReference: string
      costCenter: string
      approvalStatus: string
      approvedBy: string
      approvedAt: string
      totalGrossCents: number
      visibleOnInvoice: number
    }>()

  const headers = [
    'orderId',
    'purchaseOrderReference',
    'costCenter',
    'approvalStatus',
    'approvedBy',
    'approvedAt',
    'totalGrossCents',
    'visibleOnInvoice'
  ]

  const lines = [headers.map(csvCell).join(',')]
  for (const r of rows.results ?? []) {
    lines.push(
      [
        r.orderId,
        r.purchaseOrderReference,
        r.costCenter,
        r.approvalStatus,
        r.approvedBy,
        r.approvedAt,
        String(r.totalGrossCents),
        r.visibleOnInvoice === 1 ? 'true' : 'false'
      ]
        .map(csvCell)
        .join(',')
    )
  }

  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
