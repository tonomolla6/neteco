import { z } from 'zod'
import {
  B2B_OPEN,
  B2B_SLA_HOURS,
  addHours,
  b2bAdminCommandSchema,
  b2bCancelInputSchema,
  b2bCreateInputSchema,
  b2bDocumentInputSchema,
  b2bNextStatus,
  b2bReplyInputSchema,
  b2bSlaState,
  type B2bKind,
  type B2bSlaState,
  type B2bStatus
} from '../../shared/support-insights'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  guardedCommand,
  insightFail,
  insightHash,
  replayedCommand,
  requireSupportAdmin,
  runGuardedBatch,
  uuidKey,
  type InsightScope
} from './insight-commands'

export const B2B_MAX_OPEN_PER_COMPANY = 25
export const B2B_MAX_DOCUMENTS = 10
type Row = Record<string, string | number | null>
export interface B2bReceipt {
  id: string
  status: B2bStatus
  version: number
}
const OPEN_SQL = B2B_OPEN.map((s) => `'${s}'`).join(',')
const uuid = z.string().uuid()

async function customerContext(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  requireApproved: boolean
) {
  const customerId = await activeOrderCustomerId(db, claims, now)
  if (!customerId || !claims) return insightFail('unauthenticated')
  const company = await db
    .prepare('SELECT id,status FROM companies WHERE customer_id=?1')
    .bind(customerId)
    .first<{ id: string; status: string }>()
  if (!company || (requireApproved && company.status !== 'approved')) return insightFail('company_not_approved')
  return { customerId, companyId: company.id, identityId: claims.identityId }
}
const slaOf = (row: Row, now: string): B2bSlaState =>
  b2bSlaState(
    {
      createdAt: row.created_at as string,
      slaDueAt: row.sla_due_at as string,
      firstResponseAt: (row.first_response_at ?? row.closed_at ?? null) as string | null
    },
    now
  )
const summary = (row: Row, now: string) => ({
  id: row.id as string,
  publicRef: row.public_ref as string,
  kind: row.kind as B2bKind,
  subject: row.subject as string,
  status: row.status as B2bStatus,
  priority: row.priority as string,
  slaDueAt: row.sla_due_at as string,
  slaState: slaOf(row, now),
  firstResponseAt: row.first_response_at as string | null,
  closedAt: row.closed_at as string | null,
  version: row.version as number,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string
})
const COLUMNS =
  'r.id,r.public_ref,r.kind,r.subject,r.status,r.priority,r.sla_due_at,r.first_response_at,r.closed_at,r.version,r.created_at,r.updated_at'

function eventInsert(
  db: D1Database,
  e: {
    requestId: string
    commandId: string
    actorType: 'customer' | 'admin'
    actorId: string
    action: string
    from: string | null
    to: string
    note: string | null
    now: string
  }
) {
  return db
    .prepare(
      `INSERT INTO support_b2b_request_events(id,request_id,seq,actor_type,actor_id,action,from_status,to_status,note,created_at)
       SELECT ?1,?2,COALESCE((SELECT max(seq) FROM support_b2b_request_events WHERE request_id=?2),0)+1,?3,?4,?5,?6,?7,?8,?9
       WHERE EXISTS(SELECT 1 FROM support_insight_commands WHERE id=?10)`
    )
    .bind(crypto.randomUUID(), e.requestId, e.actorType, e.actorId, e.action, e.from, e.to, e.note, e.now, e.commandId)
}

// ----------------------------------------------------------------- customer side
export interface B2bCreateReceipt extends B2bReceipt {
  publicRef: string
  slaDueAt: string
}
export async function createB2bRequest(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<B2bCreateReceipt> {
  const parsed = b2bCreateInputSchema.safeParse(rawInput)
  const key = uuidKey(idempotencyKey)
  if (!parsed.success) return insightFail('invalid_input')
  const input = parsed.data
  const ctx = await customerContext(db, claims, now, true)
  const payloadHash = await insightHash('b2b_create', input)
  const replay = await replayedCommand<B2bCreateReceipt>(db, ctx.identityId, key, payloadHash)
  if (replay) return replay
  if (input.kind === 'claim') {
    const order = await db
      .prepare('SELECT 1 ok FROM orders WHERE id=?1 AND customer_id=?2')
      .bind(input.orderId, ctx.customerId)
      .first()
    if (!order) return insightFail('not_found')
  }
  const open = await db
    .prepare(`SELECT count(*) n FROM support_b2b_requests WHERE company_id=?1 AND status IN (${OPEN_SQL})`)
    .bind(ctx.companyId)
    .first<{ n: number }>()
  if ((open?.n ?? 0) >= B2B_MAX_OPEN_PER_COMPANY) return insightFail('limit_exceeded')
  const id = crypto.randomUUID(),
    commandId = crypto.randomUUID()
  const hours = B2B_SLA_HOURS[input.kind]
  const receipt: B2bCreateReceipt = {
    id,
    publicRef: 'B2B-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase(),
    status: 'submitted',
    slaDueAt: addHours(now, hours),
    version: 1
  }
  return runGuardedBatch<B2bCreateReceipt>(
    db,
    [
      db
        .prepare(
          `INSERT INTO support_b2b_requests(id,public_ref,company_id,customer_id,kind,subject,details,order_id,status,priority,sla_hours,sla_due_at,version,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'submitted','normal',?9,?10,1,?11,?11)`
        )
        .bind(
          id,
          receipt.publicRef,
          ctx.companyId,
          ctx.customerId,
          input.kind,
          input.subject,
          JSON.stringify(input.details),
          input.kind === 'claim' ? input.orderId : null,
          hours,
          receipt.slaDueAt,
          now
        ),
      guardedCommand(db, {
        id: commandId,
        scope: 'b2b_request',
        actorId: ctx.identityId,
        key,
        payloadHash,
        subjectId: id,
        receipt,
        now
      }),
      eventInsert(db, {
        requestId: id,
        commandId,
        actorType: 'customer',
        actorId: ctx.identityId,
        action: 'submitted',
        from: null,
        to: 'submitted',
        note: null,
        now
      })
    ],
    { id: commandId, actorId: ctx.identityId, key, payloadHash, receipt }
  )
}

const customerListSchema = z
  .object({
    status: z
      .enum(['submitted', 'in_review', 'waiting_customer', 'approved', 'rejected', 'resolved', 'cancelled'])
      .optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()
export async function listB2bRequests(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: { status?: string; limit?: number },
  now: string
) {
  const ctx = await customerContext(db, claims, now, false)
  const parsed = customerListSchema.safeParse(query)
  if (!parsed.success) return insightFail('invalid_input')
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM support_b2b_requests r WHERE r.company_id=?1 AND (?2 IS NULL OR r.status=?2) ORDER BY r.created_at DESC,r.id LIMIT ?3`
    )
    .bind(ctx.companyId, parsed.data.status ?? null, parsed.data.limit)
    .all<Row>()
  return { items: rows.results.map((row) => summary(row, now)) }
}

async function timeline(db: D1Database, requestId: string, admin: boolean) {
  const [events, documents] = await db.batch([
    db
      .prepare(
        'SELECT seq,actor_type,actor_id,action,from_status,to_status,note,created_at FROM support_b2b_request_events WHERE request_id=?1 ORDER BY seq'
      )
      .bind(requestId),
    db
      .prepare(
        'SELECT id,kind,file_name,content_type,size_bytes,sha256,scan_status,created_at FROM support_b2b_request_documents WHERE request_id=?1 ORDER BY created_at,id'
      )
      .bind(requestId)
  ])
  return {
    events: (events!.results as Row[]).map((e) => ({
      seq: e.seq as number,
      actorType: e.actor_type as 'customer' | 'admin',
      ...(admin ? { actorId: e.actor_id as string } : {}),
      action: e.action as string,
      fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string,
      note: e.note as string | null,
      createdAt: e.created_at as string
    })),
    documents: (documents!.results as Row[]).map((d) => ({
      id: d.id as string,
      kind: d.kind as string,
      fileName: d.file_name as string,
      contentType: d.content_type as string,
      sizeBytes: d.size_bytes as number,
      sha256: d.sha256 as string,
      scanStatus: d.scan_status as string,
      createdAt: d.created_at as string
    }))
  }
}
async function ownRequest(db: D1Database, companyId: string, id: string) {
  if (!uuid.safeParse(id).success) return insightFail('not_found')
  const row = await db
    .prepare(`SELECT ${COLUMNS},r.details,r.kind FROM support_b2b_requests r WHERE r.id=?1 AND r.company_id=?2`)
    .bind(id, companyId)
    .first<Row>()
  return row ?? insightFail('not_found')
}
export async function readB2bRequest(db: D1Database, claims: VerifiedSessionClaims | null, id: string, now: string) {
  const ctx = await customerContext(db, claims, now, false)
  const row = await ownRequest(db, ctx.companyId, id)
  return {
    request: { ...summary(row, now), details: JSON.parse(row.details as string) as Record<string, unknown> },
    ...(await timeline(db, id, false))
  }
}

interface Mutation {
  scope: InsightScope
  actorId: string
  actorType: 'customer' | 'admin'
  key: string
  payloadHash: string
  row: Row
  from: B2bStatus
  to: B2bStatus
  expectedVersion: number
  action: string
  note: string | null
  now: string
  owner?: string
  firstResponse?: boolean
}
async function mutateRequest(db: D1Database, m: Mutation): Promise<B2bReceipt> {
  const id = m.row.id as string,
    commandId = crypto.randomUUID()
  const closes = ['approved', 'rejected', 'resolved', 'cancelled'].includes(m.to)
  const receipt: B2bReceipt = { id, status: m.to, version: m.expectedVersion + 1 }
  return runGuardedBatch<B2bReceipt>(
    db,
    [
      db
        .prepare(
          `UPDATE support_b2b_requests SET status=?2,owner_id=COALESCE(?3,owner_id),first_response_at=COALESCE(first_response_at,?4),
             closed_at=COALESCE(closed_at,?5),version=version+1,updated_at=?6
           WHERE id=?1 AND version=?7 AND status=?8`
        )
        .bind(
          id,
          m.to,
          m.owner ?? null,
          m.firstResponse ? m.now : null,
          closes ? m.now : null,
          m.now,
          m.expectedVersion,
          m.from
        ),
      guardedCommand(db, {
        id: commandId,
        scope: m.scope,
        actorId: m.actorId,
        key: m.key,
        payloadHash: m.payloadHash,
        subjectId: id,
        receipt,
        now: m.now
      }),
      eventInsert(db, {
        requestId: id,
        commandId,
        actorType: m.actorType,
        actorId: m.actorId,
        action: m.action,
        from: m.from,
        to: m.to,
        note: m.note,
        now: m.now
      })
    ],
    { id: commandId, actorId: m.actorId, key: m.key, payloadHash: m.payloadHash, receipt }
  )
}

export async function replyB2bRequest(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
) {
  const parsed = b2bReplyInputSchema.safeParse(rawInput)
  const key = uuidKey(idempotencyKey)
  if (!parsed.success) return insightFail('invalid_input')
  const ctx = await customerContext(db, claims, now, false)
  const payloadHash = await insightHash('b2b_reply', { id, input: parsed.data })
  const replay = await replayedCommand<B2bReceipt>(db, ctx.identityId, key, payloadHash)
  if (replay) return replay
  const row = await ownRequest(db, ctx.companyId, id)
  const from = row.status as B2bStatus
  if (!B2B_OPEN.includes(from)) return insightFail('invalid_transition')
  return mutateRequest(db, {
    scope: 'b2b_request',
    actorId: ctx.identityId,
    actorType: 'customer',
    key,
    payloadHash,
    row,
    from,
    to: from === 'waiting_customer' ? 'in_review' : from,
    expectedVersion: row.version as number,
    action: 'reply',
    note: parsed.data.message,
    now
  })
}
export async function cancelB2bRequest(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
) {
  const parsed = b2bCancelInputSchema.safeParse(rawInput)
  const key = uuidKey(idempotencyKey)
  if (!parsed.success) return insightFail('invalid_input')
  const ctx = await customerContext(db, claims, now, false)
  const payloadHash = await insightHash('b2b_cancel', { id, input: parsed.data })
  const replay = await replayedCommand<B2bReceipt>(db, ctx.identityId, key, payloadHash)
  if (replay) return replay
  const row = await ownRequest(db, ctx.companyId, id)
  if (row.version !== parsed.data.expectedVersion) return insightFail('concurrency_conflict')
  const from = row.status as B2bStatus
  if (!B2B_OPEN.includes(from)) return insightFail('invalid_transition')
  return mutateRequest(db, {
    scope: 'b2b_request',
    actorId: ctx.identityId,
    actorType: 'customer',
    key,
    payloadHash,
    row,
    from,
    to: 'cancelled',
    expectedVersion: parsed.data.expectedVersion,
    action: 'cancel',
    note: parsed.data.reason ?? null,
    now
  })
}

export interface B2bDocumentReceipt {
  documentId: string
  requestId: string
  scanStatus: 'pending'
  sha256: string
}
/** Registers verified metadata only; the file stays quarantined (`pending`) until a scan receipt marks it clean. */
export async function addB2bDocument(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
) {
  const parsed = b2bDocumentInputSchema.safeParse(rawInput)
  const key = uuidKey(idempotencyKey)
  if (!parsed.success) return insightFail('invalid_input')
  const input = parsed.data
  const ctx = await customerContext(db, claims, now, false)
  const payloadHash = await insightHash('b2b_document', { id, input })
  const replay = await replayedCommand<B2bDocumentReceipt>(db, ctx.identityId, key, payloadHash)
  if (replay) return replay
  const row = await ownRequest(db, ctx.companyId, id)
  if (!B2B_OPEN.includes(row.status as B2bStatus)) return insightFail('invalid_transition')
  const stats = await db
    .prepare('SELECT count(*) n,COALESCE(sum(sha256=?2),0) same FROM support_b2b_request_documents WHERE request_id=?1')
    .bind(id, input.sha256)
    .first<{ n: number; same: number }>()
  if ((stats?.same ?? 0) > 0) return insightFail('duplicate_document')
  if ((stats?.n ?? 0) >= B2B_MAX_DOCUMENTS) return insightFail('limit_exceeded')
  const documentId = crypto.randomUUID(),
    commandId = crypto.randomUUID()
  const receipt: B2bDocumentReceipt = { documentId, requestId: id, scanStatus: 'pending', sha256: input.sha256 }
  return runGuardedBatch<B2bDocumentReceipt>(
    db,
    [
      db
        .prepare(
          `INSERT INTO support_b2b_request_documents(id,request_id,kind,file_name,content_type,size_bytes,sha256,scan_status,created_by,created_at)
           SELECT ?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9
           WHERE (SELECT status FROM support_b2b_requests WHERE id=?2) IN (${OPEN_SQL})
             AND (SELECT count(*) FROM support_b2b_request_documents WHERE request_id=?2)<${B2B_MAX_DOCUMENTS}`
        )
        .bind(
          documentId,
          id,
          input.kind,
          input.fileName,
          input.contentType,
          input.sizeBytes,
          input.sha256,
          ctx.identityId,
          now
        ),
      guardedCommand(db, {
        id: commandId,
        scope: 'b2b_request',
        actorId: ctx.identityId,
        key,
        payloadHash,
        subjectId: id,
        receipt,
        now
      }),
      eventInsert(db, {
        requestId: id,
        commandId,
        actorType: 'customer',
        actorId: ctx.identityId,
        action: 'document',
        from: row.status as string,
        to: row.status as string,
        note: input.fileName,
        now
      })
    ],
    { id: commandId, actorId: ctx.identityId, key, payloadHash, receipt }
  )
}

// ----------------------------------------------------------------- administrative side
const adminListSchema = z
  .object({
    status: z
      .enum(['submitted', 'in_review', 'waiting_customer', 'approved', 'rejected', 'resolved', 'cancelled'])
      .optional(),
    kind: z.enum(['quote', 'product_onboarding', 'documentation', 'credit', 'claim']).optional(),
    sla: z.enum(['on_track', 'at_risk', 'met', 'breached']).optional(),
    limit: z.number().int().min(1).max(200).default(100)
  })
  .strict()
export async function listAdminB2bRequests(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: Record<string, unknown>,
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = adminListSchema.safeParse(query)
  if (!parsed.success) return insightFail('invalid_input')
  const q = parsed.data
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS},c.legal_name company_name,r.owner_id FROM support_b2b_requests r JOIN companies c ON c.id=r.company_id
       WHERE (?1 IS NULL OR r.status=?1) AND (?2 IS NULL OR r.kind=?2)
       ORDER BY (r.closed_at IS NOT NULL),r.sla_due_at,r.id LIMIT ?3`
    )
    .bind(q.status ?? null, q.kind ?? null, q.limit)
    .all<Row>()
  const items = rows.results.map((row) => ({
    ...summary(row, now),
    companyName: row.company_name as string,
    ownerId: row.owner_id as string | null
  }))
  return { items: q.sla ? items.filter((item) => item.slaState === q.sla) : items }
}
export async function readAdminB2bRequest(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  if (!uuid.safeParse(id).success) return insightFail('not_found')
  const row = await db
    .prepare(
      `SELECT ${COLUMNS},r.details,r.order_id,r.owner_id,c.legal_name company_name FROM support_b2b_requests r JOIN companies c ON c.id=r.company_id WHERE r.id=?1`
    )
    .bind(id)
    .first<Row>()
  if (!row) return insightFail('not_found')
  return {
    request: {
      ...summary(row, now),
      details: JSON.parse(row.details as string) as Record<string, unknown>,
      orderId: row.order_id as string | null,
      ownerId: row.owner_id as string | null,
      companyName: row.company_name as string
    },
    ...(await timeline(db, id, true))
  }
}
export async function commandAdminB2bRequest(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  rawCommand: unknown,
  idempotencyKey: string,
  now: string
) {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = b2bAdminCommandSchema.safeParse(rawCommand)
  if (!parsed.success || !uuid.safeParse(id).success) return insightFail('invalid_input')
  const command = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('b2b_admin', { id, command })
  const replay = await replayedCommand<B2bReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  const row = await db.prepare(`SELECT ${COLUMNS} FROM support_b2b_requests r WHERE r.id=?1`).bind(id).first<Row>()
  if (!row) return insightFail('not_found')
  if (row.version !== command.expectedVersion) return insightFail('concurrency_conflict')
  const from = row.status as B2bStatus
  const isOpen = B2B_OPEN.includes(from)
  const to =
    command.action === 'reply' || command.action === 'assign'
      ? isOpen
        ? from
        : null
      : b2bNextStatus(from, command.action, row.kind as B2bKind)
  if (!to) return insightFail('invalid_transition')
  return mutateRequest(db, {
    scope: 'b2b_admin',
    actorId: admin.identityId,
    actorType: 'admin',
    key,
    payloadHash,
    row,
    from,
    to,
    expectedVersion: command.expectedVersion,
    action: command.action === 'reply' || command.action === 'assign' ? command.action : 'status',
    note: command.note ?? null,
    now,
    owner: command.action === 'assign' ? admin.identityId : undefined,
    firstResponse: command.action !== 'assign'
  })
}
