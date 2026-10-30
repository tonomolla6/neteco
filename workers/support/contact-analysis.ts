import { z } from 'zod'
import {
  BACKLOG_NEXT,
  backlogCreateInputSchema,
  backlogTransitionInputSchema,
  classifyInputSchema,
  contactAnalysisQuerySchema
} from '../../shared/support-insights'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  guardedCommand,
  insightFail,
  insightHash,
  replayedCommand,
  requireSupportAdmin,
  runGuardedBatch,
  uuidKey
} from './insight-commands'

const rate = (contacts: number, orders: number) => (orders > 0 ? Math.round((contacts / orders) * 10000) / 100 : null)
type Row = Record<string, string | number | null>

/**
 * Contact-rate analysis. Reads are aggregates only (no subject, requester or customer data) and
 * run as one batch whatever the volume. Orders are the denominator of every rate.
 */
export async function readContactAnalysis(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawQuery: unknown,
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = contactAnalysisQuerySchema.safeParse(rawQuery)
  if (!parsed.success) return insightFail('invalid_input')
  const query = parsed.data
  const from = query.from + 'T00:00:00Z',
    to = query.to + 'T00:00:00Z'
  const win = `win AS (
    SELECT t.id,t.category,t.order_id,t.product_slug,COALESCE(a.n,0) touches,COALESCE(cl.root_cause,'unclassified') root_cause
    FROM support_tickets t
    LEFT JOIN (SELECT ticket_id,count(*) n FROM support_commands WHERE actor_type='admin' GROUP BY ticket_id) a ON a.ticket_id=t.id
    LEFT JOIN support_contact_classifications cl ON cl.ticket_id=t.id
    WHERE t.created_at>=?1 AND t.created_at<?2)`
  const lab = `lab AS (SELECT order_id,min(carrier) carrier FROM carrier_shipment_labels WHERE status='confirmed' GROUP BY order_id)`
  const results = await db.batch([
    db
      .prepare(
        `WITH ${win} SELECT (SELECT count(*) FROM orders WHERE created_at>=?1 AND created_at<?2) orders,
           (SELECT count(*) FROM win) contacts,(SELECT COALESCE(sum(touches),0) FROM win) touches`
      )
      .bind(from, to),
    db
      .prepare(
        `WITH ${win} SELECT category key,count(*) contacts,sum(touches) touches FROM win GROUP BY category ORDER BY contacts DESC,key LIMIT ?3`
      )
      .bind(from, to, query.limit),
    db
      .prepare(
        `WITH ${win} SELECT root_cause key,count(*) contacts,sum(touches) touches FROM win GROUP BY root_cause ORDER BY contacts DESC,key LIMIT ?3`
      )
      .bind(from, to, query.limit),
    db
      .prepare(
        `WITH ${win},${lab} SELECT lab.carrier key,count(DISTINCT o.id) orders,
           (SELECT count(*) FROM win w JOIN lab l2 ON l2.order_id=w.order_id WHERE l2.carrier=lab.carrier) contacts
         FROM orders o JOIN lab ON lab.order_id=o.id WHERE o.created_at>=?1 AND o.created_at<?2
         GROUP BY lab.carrier ORDER BY contacts DESC,key LIMIT ?3`
      )
      .bind(from, to, query.limit),
    db
      .prepare(
        `WITH ${win} SELECT p.slug key,count(DISTINCT l.order_id) orders,(SELECT count(*) FROM win w WHERE w.product_slug=p.slug) contacts
         FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN variants v ON v.id=l.variant_id JOIN products p ON p.id=v.product_id
         WHERE o.created_at>=?1 AND o.created_at<?2 GROUP BY p.slug HAVING contacts>0 ORDER BY contacts DESC,key LIMIT ?3`
      )
      .bind(from, to, query.limit),
    db
      .prepare(
        `WITH ${win} SELECT order_id key,count(*) contacts FROM win WHERE order_id IS NOT NULL GROUP BY order_id HAVING count(*)>=2 ORDER BY contacts DESC,key LIMIT ?3`
      )
      .bind(from, to, query.limit)
  ])
  const [totalsRows, categoryRows, causeRows, carrierRows, productRows, orderRows] = results.map(
    (r) => r.results as Row[]
  )
  const totalsRow = totalsRows![0]!
  const orders = Number(totalsRow.orders),
    contacts = Number(totalsRow.contacts),
    touches = Number(totalsRow.touches)
  const cost = (n: number) =>
    query.touchCostCents === undefined ? {} : { estimatedCostCents: n * query.touchCostCents }
  const withTouches = (rows: Row[]) =>
    rows.map((r) => ({
      key: r.key as string,
      contacts: Number(r.contacts),
      touches: Number(r.touches),
      ...cost(Number(r.touches))
    }))
  const withRate = (rows: Row[]) =>
    rows.map((r) => ({
      key: r.key as string,
      orders: Number(r.orders),
      contacts: Number(r.contacts),
      ratePer100Orders: rate(Number(r.contacts), Number(r.orders))
    }))
  const byCategory = withTouches(categoryRows!),
    byRootCause = withTouches(causeRows!),
    byCarrier = withRate(carrierRows!),
    byProduct = withRate(productRows!)

  const suggestions: Array<{
    dimension: 'carrier' | 'product' | 'category' | 'root_cause'
    dimensionKey: string
    rootCause: string
    contacts: number
    sharePct: number
    ratePer100Orders: number | null
    priority: 'normal' | 'high'
    title: string
  }> = []
  const consider = (
    dimension: 'carrier' | 'product' | 'category' | 'root_cause',
    label: string,
    key: string,
    groupContacts: number,
    groupRate: number | null
  ) => {
    if (contacts === 0 || groupContacts < 3 || (groupContacts / contacts) * 100 < 25) return
    const sharePct = Math.round((groupContacts / contacts) * 10000) / 100
    suggestions.push({
      dimension,
      dimensionKey: key,
      rootCause: dimension === 'root_cause' ? key : 'unclassified',
      contacts: groupContacts,
      sharePct,
      ratePer100Orders: groupRate,
      priority: sharePct >= 50 ? 'high' : 'normal',
      title: `Reducir contactos por ${label}: ${key}`
    })
  }
  for (const r of byCarrier) consider('carrier', 'transportista', r.key, r.contacts, r.ratePer100Orders)
  for (const r of byProduct) consider('product', 'producto', r.key, r.contacts, r.ratePer100Orders)
  for (const r of byCategory) consider('category', 'categoría', r.key, r.contacts, null)
  for (const r of byRootCause)
    if (r.key !== 'unclassified') consider('root_cause', 'causa raíz', r.key, r.contacts, null)

  return {
    window: { from: query.from, to: query.to },
    totals: {
      orders,
      contacts,
      ratePer100Orders: rate(contacts, orders),
      touches,
      estimatedCostCents: query.touchCostCents === undefined ? null : touches * query.touchCostCents
    },
    byCategory,
    byRootCause,
    byCarrier,
    byProduct,
    byOrder: orderRows!.map((r) => ({ key: r.key as string, contacts: Number(r.contacts) })),
    suggestions
  }
}

export interface ClassificationReceipt {
  ticketId: string
  rootCause: string
  version: number
}
export async function classifyTicketRootCause(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<ClassificationReceipt> {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = classifyInputSchema.safeParse(rawInput)
  if (!parsed.success) return insightFail('invalid_input')
  const input = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('contact_classify', input)
  const replay = await replayedCommand<ClassificationReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  const ticket = await db.prepare('SELECT id FROM support_tickets WHERE id=?1').bind(input.ticketId).first()
  if (!ticket) return insightFail('not_found')
  const current = await db
    .prepare('SELECT version FROM support_contact_classifications WHERE ticket_id=?1')
    .bind(input.ticketId)
    .first<{ version: number }>()
  if ((current?.version ?? 0) !== input.expectedVersion) return insightFail('concurrency_conflict')
  const commandId = crypto.randomUUID()
  const receipt: ClassificationReceipt = {
    ticketId: input.ticketId,
    rootCause: input.rootCause,
    version: input.expectedVersion + 1
  }
  const write =
    input.expectedVersion === 0
      ? db
          .prepare(
            `INSERT INTO support_contact_classifications(ticket_id,root_cause,classified_by,note,version,created_at,updated_at)
             SELECT ?1,?2,?3,?4,1,?5,?5 WHERE NOT EXISTS(SELECT 1 FROM support_contact_classifications WHERE ticket_id=?1)`
          )
          .bind(input.ticketId, input.rootCause, admin.identityId, input.note ?? null, now)
      : db
          .prepare(
            `UPDATE support_contact_classifications SET root_cause=?2,classified_by=?3,note=?4,version=version+1,updated_at=?5
             WHERE ticket_id=?1 AND version=?6`
          )
          .bind(input.ticketId, input.rootCause, admin.identityId, input.note ?? null, now, input.expectedVersion)
  return runGuardedBatch(
    db,
    [
      write,
      guardedCommand(db, {
        id: commandId,
        scope: 'contact_classify',
        actorId: admin.identityId,
        key,
        payloadHash,
        subjectId: input.ticketId,
        receipt,
        now
      })
    ],
    {
      id: commandId,
      actorId: admin.identityId,
      key,
      payloadHash,
      receipt
    }
  )
}

export interface BacklogReceipt {
  id: string
  status: string
  version: number
}
async function requireRca(db: D1Database, rcaId: string | undefined) {
  if (rcaId === undefined) return
  const rca = await db.prepare('SELECT 1 ok FROM support_operational_rcas WHERE id=?1').bind(rcaId).first()
  if (!rca) insightFail('invalid_input')
}
export async function createContactBacklogItem(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<BacklogReceipt> {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = backlogCreateInputSchema.safeParse(rawInput)
  if (!parsed.success) return insightFail('invalid_input')
  const input = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('contact_backlog_create', input)
  const replay = await replayedCommand<BacklogReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  await requireRca(db, input.rcaId)
  const from = input.from + 'T00:00:00Z',
    to = input.to + 'T00:00:00Z'
  const duplicate = await db
    .prepare(
      'SELECT id FROM support_contact_backlog_items WHERE dimension=?1 AND dimension_key=?2 AND root_cause=?3 AND window_from=?4 AND window_to=?5'
    )
    .bind(input.dimension, input.dimensionKey, input.rootCause, from, to)
    .first()
  if (duplicate) return insightFail('duplicate_backlog')
  const id = crypto.randomUUID(),
    commandId = crypto.randomUUID()
  const receipt: BacklogReceipt = { id, status: 'open', version: 1 }
  return runGuardedBatch(
    db,
    [
      db
        .prepare(
          `INSERT INTO support_contact_backlog_items(id,dimension,dimension_key,root_cause,title,evidence,priority,status,rca_id,window_from,window_to,version,created_by,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9,?10,1,?11,?12,?12)`
        )
        .bind(
          id,
          input.dimension,
          input.dimensionKey,
          input.rootCause,
          input.title,
          JSON.stringify(input.evidence),
          input.priority,
          input.rcaId ?? null,
          from,
          to,
          admin.identityId,
          now
        ),
      guardedCommand(db, {
        id: commandId,
        scope: 'contact_backlog',
        actorId: admin.identityId,
        key,
        payloadHash,
        subjectId: id,
        receipt,
        now
      })
    ],
    { id: commandId, actorId: admin.identityId, key, payloadHash, receipt }
  )
}
export async function transitionContactBacklogItem(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<BacklogReceipt> {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = backlogTransitionInputSchema.safeParse(rawInput)
  if (!parsed.success || !z.string().uuid().safeParse(id).success) return insightFail('invalid_input')
  const input = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('contact_backlog_transition', { id, input })
  const replay = await replayedCommand<BacklogReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  await requireRca(db, input.rcaId)
  const row = await db
    .prepare('SELECT status,version FROM support_contact_backlog_items WHERE id=?1')
    .bind(id)
    .first<{ status: string; version: number }>()
  if (!row) return insightFail('not_found')
  if (row.version !== input.expectedVersion) return insightFail('concurrency_conflict')
  const next = BACKLOG_NEXT[row.status]?.[input.action]
  if (!next) return insightFail('invalid_transition')
  const commandId = crypto.randomUUID()
  const receipt: BacklogReceipt = { id, status: next, version: row.version + 1 }
  return runGuardedBatch(
    db,
    [
      db
        .prepare(
          `UPDATE support_contact_backlog_items SET status=?2,rca_id=COALESCE(?3,rca_id),version=version+1,updated_at=?4
           WHERE id=?1 AND version=?5 AND status=?6`
        )
        .bind(id, next, input.rcaId ?? null, now, input.expectedVersion, row.status),
      guardedCommand(db, {
        id: commandId,
        scope: 'contact_backlog',
        actorId: admin.identityId,
        key,
        payloadHash,
        subjectId: id,
        receipt,
        now
      })
    ],
    { id: commandId, actorId: admin.identityId, key, payloadHash, receipt }
  )
}
const backlogListSchema = z
  .object({
    status: z.enum(['open', 'planned', 'done', 'dismissed']).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()
export async function listContactBacklog(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: { status?: string; limit?: number },
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = backlogListSchema.safeParse(query)
  if (!parsed.success) return insightFail('invalid_input')
  const rows = await db
    .prepare(
      `SELECT id,dimension,dimension_key,root_cause,title,evidence,priority,status,rca_id,window_from,window_to,version,created_at
       FROM support_contact_backlog_items WHERE (?1 IS NULL OR status=?1)
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,created_at,id LIMIT ?2`
    )
    .bind(parsed.data.status ?? null, parsed.data.limit)
    .all<Row>()
  return {
    items: rows.results.map((r) => ({
      id: r.id as string,
      dimension: r.dimension as string,
      dimensionKey: r.dimension_key as string,
      rootCause: r.root_cause as string,
      title: r.title as string,
      evidence: JSON.parse(r.evidence as string) as Record<string, unknown>,
      priority: r.priority as string,
      status: r.status as string,
      rcaId: r.rca_id as string | null,
      windowFrom: r.window_from as string,
      windowTo: r.window_to as string,
      version: r.version as number,
      createdAt: r.created_at as string
    }))
  }
}
