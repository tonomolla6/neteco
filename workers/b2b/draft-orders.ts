import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type CreateDraftOrderInput,
  type ReviewDraftOrderInput,
  type DraftOrder,
  type DraftOrderTimelineEvent,
  createDraftOrderInputSchema,
  reviewDraftOrderInputSchema,
  assertDraftOrderCanBeApprovedOrConverted
} from '../../shared/draft-orders'

export class DraftOrderError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'DraftOrderError'
  }
}

export async function authorizeOrders(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now?: string
): Promise<void> {
  const resOrders = await authorizeD1Session(database, claims, 'orders.manage', {
    now,
    requireMfa: true
  })
  if (resOrders.allowed) return

  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  if (resOrders.code === 'unauthenticated' || resManage.code === 'unauthenticated') {
    throw new DraftOrderError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new DraftOrderError('forbidden', 'Requires orders.manage or administration.manage permission')
}

type DraftTimelineEntry = {
  eventType: string
  fromStatus: string | null
  toStatus: string
  actorType: 'customer' | 'approver' | 'system'
  actorId: string
  notes: string | null
}

/**
 * One atomic CAS step: the timeline event and the state change run in the same D1 batch and both are
 * guarded by the version the caller read, so a lost race writes nothing (no orphan timeline event).
 */
async function applyDraftTransition(
  database: D1Database,
  draft: { id: string; version: number },
  setClause: string,
  setBinds: unknown[],
  entry: DraftTimelineEntry,
  now: string
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO draft_order_timeline (
           id, draft_order_id, event_type, from_status, to_status, actor_type, actor_id, notes, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM draft_orders WHERE id = ? AND version = ?)`
      )
      .bind(
        crypto.randomUUID(),
        draft.id,
        entry.eventType,
        entry.fromStatus,
        entry.toStatus,
        entry.actorType,
        entry.actorId,
        entry.notes,
        now,
        draft.id,
        draft.version
      ),
    database
      .prepare(
        `UPDATE draft_orders SET ${setClause}, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id`
      )
      .bind(...setBinds, draft.version + 1, now, draft.id, draft.version)
  ])
  if (!results[1]?.results?.length) {
    throw new DraftOrderError('version_conflict', 'Draft order was modified concurrently')
  }
}

export type DraftOrderOptions = {
  now?: string
}

function calculateExpiration(nowIso: string, hours: number): string {
  const d = new Date(nowIso)
  d.setUTCHours(d.getUTCHours() + hours)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function createDraftOrder(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CreateDraftOrderInput,
  options?: DraftOrderOptions
): Promise<DraftOrder> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeOrders(database, claims, now)

  const input = createDraftOrderInputSchema.parse(rawInput)

  // Calculate totals in financial cents
  let subtotalCents = 0
  for (const item of input.items) {
    subtotalCents += item.lineTotalCents
  }
  const taxCents = Math.round((subtotalCents * input.taxRatePercent) / 100)
  const shippingCents = input.shippingCents ?? 0
  const totalCents = subtotalCents + taxCents + shippingCents

  const id = crypto.randomUUID()
  const randomSuffix = Math.floor(100000 + Math.random() * 900000)
  const draftNumber = `DFT-${new Date(now).getUTCFullYear()}-${randomSuffix}`
  const expiresAt = calculateExpiration(now, input.expiresInHours)

  // Enforces acceptance criteria:
  // "No reserva/cobra de forma indefinida; timeline y expiración definidos."
  const inventoryReserved = 0
  const paymentStatus = 'unbilled'

  const insertDraft = database
    .prepare(
      `INSERT INTO draft_orders (
         id, draft_number, customer_id, company_name, contact_email,
         status, total_cents, subtotal_cents, tax_cents, shipping_cents,
         currency, items_json, inventory_reserved, payment_status,
         expires_at, version, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .bind(
      id,
      draftNumber,
      input.customerId,
      input.companyName,
      input.contactEmail,
      totalCents,
      subtotalCents,
      taxCents,
      shippingCents,
      JSON.stringify(input.items),
      inventoryReserved,
      paymentStatus,
      expiresAt,
      claims.identityId,
      now,
      now
    )

  // Timeline record: created
  const timelineId = crypto.randomUUID()
  const insertTimeline = database
    .prepare(
      `INSERT INTO draft_order_timeline (
         id, draft_order_id, event_type, from_status, to_status,
         actor_type, actor_id, notes, created_at
       ) VALUES (?, ?, 'created', NULL, 'draft', 'customer', ?, 'Borrador de pedido creado', ?)`
    )
    .bind(timelineId, id, claims.identityId, now)
  await database.batch([insertDraft, insertTimeline])

  return (await getDraftOrder(database, id))!
}

export async function submitDraftOrderForApproval(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    draftOrderId: string
    expectedVersion: number
    notes?: string
  },
  options?: DraftOrderOptions
): Promise<DraftOrder> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeOrders(database, claims, now)

  const draft = await getDraftOrder(database, input.draftOrderId)
  if (!draft) {
    throw new DraftOrderError('not_found', 'Draft order not found')
  }

  assertDraftOrderCanBeApprovedOrConverted(draft, now)

  if (draft.version !== input.expectedVersion) {
    throw new DraftOrderError('version_conflict', `Expected version ${input.expectedVersion}, found ${draft.version}`)
  }

  await applyDraftTransition(
    database,
    draft,
    `status = 'pending_approval', approval_requested_at = ?`,
    [now],
    {
      eventType: 'submitted_for_approval',
      fromStatus: 'draft',
      toStatus: 'pending_approval',
      actorType: 'customer',
      actorId: claims.identityId,
      notes: input.notes ?? 'Enviado para revisión y aprobación comercial'
    },
    now
  )

  return (await getDraftOrder(database, draft.id))!
}

export async function reviewDraftOrder(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: ReviewDraftOrderInput,
  options?: DraftOrderOptions
): Promise<DraftOrder> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeOrders(database, claims, now)

  const input = reviewDraftOrderInputSchema.parse(rawInput)
  const draft = await getDraftOrder(database, input.draftOrderId)
  if (!draft) {
    throw new DraftOrderError('not_found', 'Draft order not found')
  }

  assertDraftOrderCanBeApprovedOrConverted(draft, now)

  if (draft.version !== input.expectedVersion) {
    throw new DraftOrderError('version_conflict', `Expected version ${input.expectedVersion}, found ${draft.version}`)
  }

  const newStatus = input.decision
  await applyDraftTransition(
    database,
    draft,
    input.decision === 'approved'
      ? `status = 'approved', approved_at = ?, approved_by = ?`
      : `status = 'rejected', rejection_reason = ?`,
    input.decision === 'approved' ? [now, claims.identityId] : [input.notes ?? 'Rechazado por aprobador'],
    {
      eventType: input.decision,
      fromStatus: draft.status,
      toStatus: newStatus,
      actorType: 'approver',
      actorId: claims.identityId,
      notes: input.notes ?? null
    },
    now
  )

  return (await getDraftOrder(database, draft.id))!
}

export async function convertDraftOrderToConfirmed(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: {
    draftOrderId: string
    expectedVersion: number
    confirmedOrderId: string
  },
  options?: DraftOrderOptions
): Promise<DraftOrder> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeOrders(database, claims, now)

  const draft = await getDraftOrder(database, input.draftOrderId)
  if (!draft) {
    throw new DraftOrderError('not_found', 'Draft order not found')
  }

  // Acceptance rule: cannot convert expired draft orders
  if (draft.expiresAt <= now) {
    throw new DraftOrderError('draft_order_expired', 'Draft order has expired and cannot be converted')
  }

  if (draft.status !== 'approved') {
    throw new DraftOrderError('not_approved', 'Draft order must be approved before conversion')
  }

  if (draft.version !== input.expectedVersion) {
    throw new DraftOrderError('version_conflict', `Expected version ${input.expectedVersion}, found ${draft.version}`)
  }

  await applyDraftTransition(
    database,
    draft,
    `status = 'converted', converted_order_id = ?`,
    [input.confirmedOrderId],
    {
      eventType: 'converted',
      fromStatus: 'approved',
      toStatus: 'converted',
      actorType: 'system',
      actorId: claims.identityId,
      notes: 'Convertido a pedido firme'
    },
    now
  )

  return (await getDraftOrder(database, draft.id))!
}

export async function sweepExpiredDraftOrders(database: D1Database, now: string): Promise<{ expiredCount: number }> {
  // Find all drafts past expiration that are not yet closed
  const rows = await database
    .prepare(
      `SELECT id, status, version
       FROM draft_orders
       WHERE status IN ('draft', 'pending_approval', 'approved') AND expires_at <= ?`
    )
    .bind(now)
    .all<{ id: string; status: string; version: number }>()

  let expiredCount = 0
  for (const row of rows.results || []) {
    try {
      await applyDraftTransition(
        database,
        { id: row.id, version: row.version },
        `status = 'expired'`,
        [],
        {
          eventType: 'expired',
          fromStatus: row.status,
          toStatus: 'expired',
          actorType: 'system',
          actorId: 'system',
          notes: 'Borrador expirado por vencimiento del plazo'
        },
        now
      )
      expiredCount++
    } catch (error) {
      // Another writer moved this draft first: it is no longer ours to expire.
      if (!(error instanceof DraftOrderError && error.code === 'version_conflict')) throw error
    }
  }

  return { expiredCount }
}

export async function getDraftOrder(database: D1Database, draftId: string): Promise<DraftOrder | null> {
  const row = await database
    .prepare(
      `SELECT id, draft_number, customer_id, company_name, contact_email,
              status, total_cents, subtotal_cents, tax_cents, shipping_cents,
              currency, items_json, inventory_reserved, payment_status,
              expires_at, approval_requested_at, approved_at, approved_by,
              rejection_reason, converted_order_id, version, created_by,
              created_at, updated_at
       FROM draft_orders
       WHERE id = ?`
    )
    .bind(draftId)
    .first<{
      id: string
      draft_number: string
      customer_id: string
      company_name: string
      contact_email: string
      status: string
      total_cents: number
      subtotal_cents: number
      tax_cents: number
      shipping_cents: number
      currency: string
      items_json: string
      inventory_reserved: number
      payment_status: string
      expires_at: string
      approval_requested_at: string | null
      approved_at: string | null
      approved_by: string | null
      rejection_reason: string | null
      converted_order_id: string | null
      version: number
      created_by: string
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  const timelineRows = await database
    .prepare(
      `SELECT id, draft_order_id, event_type, from_status, to_status,
              actor_type, actor_id, notes, created_at
       FROM draft_order_timeline
       WHERE draft_order_id = ?
       ORDER BY created_at ASC`
    )
    .bind(draftId)
    .all<{
      id: string
      draft_order_id: string
      event_type: string
      from_status: string | null
      to_status: string
      actor_type: 'customer' | 'approver' | 'system'
      actor_id: string
      notes: string | null
      created_at: string
    }>()

  const timeline: DraftOrderTimelineEvent[] = (timelineRows.results || []).map((t) => ({
    id: t.id,
    draftOrderId: t.draft_order_id,
    eventType: t.event_type,
    fromStatus: t.from_status,
    toStatus: t.to_status,
    actorType: t.actor_type,
    actorId: t.actor_id,
    notes: t.notes,
    createdAt: t.created_at
  }))

  return {
    id: row.id,
    draftNumber: row.draft_number,
    customerId: row.customer_id,
    companyName: row.company_name,
    contactEmail: row.contact_email,
    status: row.status,
    totalCents: row.total_cents,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    shippingCents: row.shipping_cents,
    currency: row.currency,
    items: JSON.parse(row.items_json),
    inventoryReserved: row.inventory_reserved,
    paymentStatus: row.payment_status,
    expiresAt: row.expires_at,
    approvalRequestedAt: row.approval_requested_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectionReason: row.rejection_reason,
    convertedOrderId: row.converted_order_id,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeline
  }
}

export async function listDraftOrders(
  database: D1Database,
  filters?: { customerId?: string; status?: string }
): Promise<DraftOrder[]> {
  let query = `
    SELECT id
    FROM draft_orders
    WHERE 1=1
  `
  const bindings: unknown[] = []
  if (filters?.customerId) {
    query += ` AND customer_id = ?`
    bindings.push(filters.customerId)
  }
  if (filters?.status) {
    query += ` AND status = ?`
    bindings.push(filters.status)
  }
  query += ` ORDER BY created_at DESC`

  const rows = await database
    .prepare(query)
    .bind(...bindings)
    .all<{ id: string }>()

  const list: DraftOrder[] = []
  for (const r of rows.results || []) {
    const item = await getDraftOrder(database, r.id)
    if (item) list.push(item)
  }
  return list
}
