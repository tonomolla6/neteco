import { sha256Hex, canonicalJson } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'

export type DeliverySurveyErrorCode =
  | 'not_found'
  | 'token_expired'
  | 'token_used'
  | 'invalid_input'
  | 'order_not_delivered'
  | 'unauthenticated'
  | 'forbidden'
  | 'service_unavailable'
  | 'conflict'

export class DeliverySurveyError extends Error {
  constructor(readonly code: DeliverySurveyErrorCode) {
    super(code)
    this.name = 'DeliverySurveyError'
  }
}

export const CONTACT_REASONS = [
  'damaged_product',
  'missing_items',
  'late_delivery',
  'wrong_product',
  'packaging_issue',
  'delivery_agent_issue',
  'billing_issue',
  'product_inquiry',
  'compliment',
  'other'
] as const

export type ContactReason = (typeof CONTACT_REASONS)[number]

export const CONTACT_REASON_LABELS: Record<ContactReason, string> = {
  damaged_product: 'Producto dañado o roto',
  missing_items: 'Falta producto / pedido incompleto',
  late_delivery: 'Retraso en la entrega',
  wrong_product: 'Producto equivocado o no coincide',
  packaging_issue: 'Embalaje defectuoso',
  delivery_agent_issue: 'Problema con el transportista / repartidor',
  billing_issue: 'Duda o incidencia con la factura',
  product_inquiry: 'Consulta técnica sobre el uso del producto',
  compliment: 'Felicitación / buen servicio',
  other: 'Otro motivo'
}

export const PROBLEM_CONTACT_REASONS: ReadonlySet<ContactReason> = new Set([
  'damaged_product',
  'missing_items',
  'late_delivery',
  'wrong_product',
  'packaging_issue',
  'delivery_agent_issue',
  'billing_issue'
])

export type CustomerSegment = 'particular' | 'profesional'

export interface DeliverySurveyInvitation {
  id: string
  orderId: string
  customerId: string | null
  recipientEmail: string
  customerSegment: CustomerSegment
  token: string
  status: 'scheduled' | 'suppressed' | 'completed' | 'expired'
  suppressionReason: 'opt_out' | 'delivery_updates_disabled' | 'manual_opt_out' | null
  scheduledAt: string
  expiresAt: string
  outboxEventId: string | null
  createdAt: string
  updatedAt: string
}

export interface DeliverySurveyDetails {
  orderId: string
  orderNumber: string
  recipientName: string
  recipientEmail: string
  customerSegment: CustomerSegment
  status: 'scheduled' | 'suppressed' | 'completed' | 'expired'
  scheduledAt: string
  expiresAt: string
  catalogReasons: typeof CONTACT_REASONS
}

export interface ScheduleSurveyInput {
  orderId: string
  now?: string
}

export interface ScheduleSurveyResult {
  outcome: 'scheduled' | 'idempotent' | 'suppressed'
  invitation: DeliverySurveyInvitation
}

export interface SubmitSurveyInput {
  token: string
  score: number
  arrivedGood: boolean
  contactReason?: ContactReason | null
  comment?: string | null
}

export interface SubmitSurveyResult {
  ok: true
  responseId: string
  hasProblem: boolean
  supportTicket: {
    ticketId: string
    publicRef: string
    created: boolean
    url: string
  } | null
}

export interface AdminDeliverySurveysQuery {
  from?: string
  to?: string
  segment?: 'all' | 'particular' | 'profesional'
  contactReason?: ContactReason | 'all'
  minSampleThreshold?: number
  page?: number
  perPage?: number
  now?: string
}

export interface AdminDeliverySurveysDashboard {
  period: {
    from: string | null
    to: string | null
  }
  minSampleThreshold: number
  summary: {
    totalInvitations: number
    completedSurveys: number
    responseRate: number | null
    averageScore: number | null
    arrivedGoodRate: number | null
    problemRate: number | null
    totalTicketsCreated: number
    hasSufficientSample: boolean
  }
  bySegment: {
    particular: {
      count: number
      averageScore: number | null
      arrivedGoodRate: number | null
      problemRate: number | null
      hasSufficientSample: boolean
    }
    profesional: {
      count: number
      averageScore: number | null
      arrivedGoodRate: number | null
      problemRate: number | null
      hasSufficientSample: boolean
    }
  }
  byReason: Array<{
    reason: ContactReason
    label: string
    count: number
    percentage: number | null
    averageScore: number | null
    hasSufficientSample: boolean
  }>
  scoreDistribution: Record<1 | 2 | 3 | 4 | 5, number>
  items: Array<{
    id: string
    orderId: string
    orderNumber: string
    score: number
    arrivedGood: boolean
    contactReason: ContactReason | null
    customerSegment: CustomerSegment
    hasProblem: boolean
    supportTicketPublicRef: string | null
    submittedAt: string
  }>
  pagination: {
    page: number
    perPage: number
    total: number
  }
}

export function isProblemSurvey(score: number, arrivedGood: boolean, contactReason?: ContactReason | null): boolean {
  if (!arrivedGood) return true
  if (score <= 2) return true
  if (contactReason && PROBLEM_CONTACT_REASONS.has(contactReason)) return true
  return false
}

function plusDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function determineCustomerSegment(database: D1Database, orderId: string): Promise<CustomerSegment> {
  const order = await database
    .prepare(
      `SELECT o.customer_id, o.buyer_company_name, o.buyer_tax_id,
        (SELECT count(*) FROM companies c WHERE c.customer_id = o.customer_id AND c.status IN ('approved', 'active')) as company_count
       FROM orders o
       WHERE o.id = ?`
    )
    .bind(orderId)
    .first<{
      customer_id: string | null
      buyer_company_name: string | null
      buyer_tax_id: string | null
      company_count: number | null
    }>()

  if (!order) return 'particular'
  if (
    (order.buyer_company_name && order.buyer_company_name.trim().length > 0) ||
    (order.buyer_tax_id && order.buyer_tax_id.trim().length > 0) ||
    (order.company_count && order.company_count > 0)
  ) {
    return 'profesional'
  }
  return 'particular'
}

export async function isSurveyOptedOut(
  database: D1Database,
  email: string,
  customerId?: string | null
): Promise<{ optedOut: boolean; reason?: 'opt_out' | 'delivery_updates_disabled' }> {
  const emailHash = await sha256Hex(email.toLowerCase().trim())
  const optOutRow = await database
    .prepare('SELECT reason FROM delivery_survey_opt_outs WHERE email_hash = ?')
    .bind(emailHash)
    .first<{ reason: string }>()
  if (optOutRow) {
    return { optedOut: true, reason: 'opt_out' }
  }

  if (customerId) {
    try {
      const pref = await database
        .prepare('SELECT delivery_updates FROM delivery_preferences WHERE customer_id = ?')
        .bind(customerId)
        .first<{ delivery_updates: number }>()
      if (pref && pref.delivery_updates === 0) {
        return { optedOut: true, reason: 'delivery_updates_disabled' }
      }
    } catch {
      // Table might not exist in some isolation fixtures
    }
  }

  return { optedOut: false }
}

function mapInvitationRow(row: Record<string, unknown>): DeliverySurveyInvitation {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    customerId: row.customer_id ? String(row.customer_id) : null,
    recipientEmail: String(row.recipient_email),
    customerSegment: row.customer_segment as CustomerSegment,
    token: String(row.token),
    status: row.status as 'scheduled' | 'suppressed' | 'completed' | 'expired',
    suppressionReason: row.suppression_reason as 'opt_out' | 'delivery_updates_disabled' | null,
    scheduledAt: String(row.scheduled_at),
    expiresAt: String(row.expires_at),
    outboxEventId: row.outbox_event_id ? String(row.outbox_event_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/**
 * Schedules a post-delivery survey invitation (idempotent, once per order).
 * Checks delivery status, opt-out preferences, customer segmentation,
 * generates a single-use expiring token, and enqueues to email outbox.
 */
export async function scheduleDeliverySurveyInvitation(
  database: D1Database,
  input: ScheduleSurveyInput
): Promise<ScheduleSurveyResult> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const orderId = input.orderId

  // 1. Verify order and delivery state
  const orderRow = await database
    .prepare(
      `SELECT o.id, o.status, o.customer_id, o.contact_email, o.contact_name,
              f.status as fulfillment_status, f.updated_at as delivered_at
       FROM orders o
       LEFT JOIN order_fulfillments f ON f.order_id = o.id
       WHERE o.id = ?`
    )
    .bind(orderId)
    .first<{
      id: string
      status: string
      customer_id: string | null
      contact_email: string
      contact_name: string
      fulfillment_status: string | null
      delivered_at: string | null
    }>()

  if (!orderRow) {
    throw new DeliverySurveyError('not_found')
  }

  if (orderRow.fulfillment_status !== 'delivered') {
    throw new DeliverySurveyError('order_not_delivered')
  }

  // 2. Check if already scheduled (idempotency: once per order)
  const existing = await database
    .prepare('SELECT * FROM delivery_survey_invitations WHERE order_id = ?')
    .bind(orderId)
    .first<Record<string, unknown>>()

  if (existing) {
    return {
      outcome: 'idempotent',
      invitation: mapInvitationRow(existing)
    }
  }

  // 3. Determine segment & opt-out
  const segment = await determineCustomerSegment(database, orderId)
  const optOut = await isSurveyOptedOut(database, orderRow.contact_email, orderRow.customer_id)

  const id = crypto.randomUUID()
  const token = crypto.randomUUID().replace(/-/g, '')
  const expiresAt = plusDays(now, 14) // 14 days expiration

  if (optOut.optedOut) {
    const suppressedInvitation: DeliverySurveyInvitation = {
      id,
      orderId,
      customerId: orderRow.customer_id,
      recipientEmail: orderRow.contact_email,
      customerSegment: segment,
      token,
      status: 'suppressed',
      suppressionReason: optOut.reason ?? 'opt_out',
      scheduledAt: now,
      expiresAt,
      outboxEventId: null,
      createdAt: now,
      updatedAt: now
    }

    await database
      .prepare(
        `INSERT INTO delivery_survey_invitations
         (id, order_id, customer_id, recipient_email, customer_segment, token, status, suppression_reason, scheduled_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'suppressed', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        orderId,
        orderRow.customer_id,
        orderRow.contact_email,
        segment,
        token,
        optOut.reason ?? 'opt_out',
        now,
        expiresAt,
        now,
        now
      )
      .run()

    return {
      outcome: 'suppressed',
      invitation: suppressedInvitation
    }
  }

  // 4. Not opted out -> schedule invitation and record outbox event
  let outboxEventId: string | null = null
  try {
    const outboxStatement = await prepareEmailOutboxEnqueue(database, {
      sourceEventId: id,
      sourceKind: 'order',
      sourceId: orderId,
      eventType: 'order.delivered',
      now
    })
    await database.batch([
      database
        .prepare(
          `INSERT INTO delivery_survey_invitations
           (id, order_id, customer_id, recipient_email, customer_segment, token, status, outbox_event_id, scheduled_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`
        )
        .bind(id, orderId, orderRow.customer_id, orderRow.contact_email, segment, token, id, now, expiresAt, now, now),
      outboxStatement.statement
    ])
    outboxEventId = id
  } catch {
    // If outbox tables or batch fails, fall back to standalone insert
    await database
      .prepare(
        `INSERT INTO delivery_survey_invitations
         (id, order_id, customer_id, recipient_email, customer_segment, token, status, scheduled_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`
      )
      .bind(id, orderId, orderRow.customer_id, orderRow.contact_email, segment, token, now, expiresAt, now, now)
      .run()
  }

  return {
    outcome: 'scheduled',
    invitation: {
      id,
      orderId,
      customerId: orderRow.customer_id,
      recipientEmail: orderRow.contact_email,
      customerSegment: segment,
      token,
      status: 'scheduled',
      suppressionReason: null,
      scheduledAt: now,
      expiresAt,
      outboxEventId,
      createdAt: now,
      updatedAt: now
    }
  }
}

/**
 * Reads public survey invitation details by single-use token without login.
 */
export async function readDeliverySurveyByToken(
  database: D1Database,
  token: string,
  options?: { now?: string }
): Promise<DeliverySurveyDetails> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!token || typeof token !== 'string' || token.length < 16) {
    throw new DeliverySurveyError('not_found')
  }

  const row = await database
    .prepare(
      `SELECT i.*, o.id as order_id, o.contact_name
       FROM delivery_survey_invitations i
       JOIN orders o ON o.id = i.order_id
       WHERE i.token = ?`
    )
    .bind(token)
    .first<Record<string, unknown>>()

  if (!row) {
    throw new DeliverySurveyError('not_found')
  }

  if (row.status === 'completed') {
    throw new DeliverySurveyError('token_used')
  }

  if (String(row.expires_at) < now) {
    throw new DeliverySurveyError('token_expired')
  }

  if (row.status === 'suppressed') {
    throw new DeliverySurveyError('not_found')
  }

  return {
    orderId: String(row.order_id),
    orderNumber: String(row.order_id).slice(0, 8).toUpperCase(),
    recipientName: String(row.contact_name ?? ''),
    recipientEmail: String(row.recipient_email),
    customerSegment: row.customer_segment as CustomerSegment,
    status: row.status as 'scheduled',
    scheduledAt: String(row.scheduled_at),
    expiresAt: String(row.expires_at),
    catalogReasons: CONTACT_REASONS
  }
}

/**
 * Submits post-delivery survey response with single-use token.
 * If problem detected, creates or reuses support ticket without duplicating.
 */
export async function submitDeliverySurvey(
  database: D1Database,
  rawInput: SubmitSurveyInput,
  options?: { now?: string }
): Promise<SubmitSurveyResult> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Validate input
  const token = rawInput.token
  if (!token || typeof token !== 'string') throw new DeliverySurveyError('invalid_input')

  const score = rawInput.score
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new DeliverySurveyError('invalid_input')

  const arrivedGood = Boolean(rawInput.arrivedGood)
  const contactReason = rawInput.contactReason ?? null
  if (contactReason !== null && !CONTACT_REASONS.includes(contactReason)) {
    throw new DeliverySurveyError('invalid_input')
  }

  const comment = rawInput.comment ? rawInput.comment.trim() : null
  if (comment !== null && (comment.length === 0 || comment.length > 1000)) {
    throw new DeliverySurveyError('invalid_input')
  }

  // Look up invitation
  const invitation = await database
    .prepare(
      `SELECT i.*, o.contact_name, o.contact_phone, o.customer_id as order_customer_id
       FROM delivery_survey_invitations i
       JOIN orders o ON o.id = i.order_id
       WHERE i.token = ?`
    )
    .bind(token)
    .first<{
      id: string
      order_id: string
      customer_id: string | null
      recipient_email: string
      customer_segment: CustomerSegment
      token: string
      status: string
      expires_at: string
      contact_name: string
      contact_phone: string
      order_customer_id: string | null
    }>()

  if (!invitation) throw new DeliverySurveyError('not_found')
  if (invitation.status === 'completed') throw new DeliverySurveyError('token_used')
  if (invitation.expires_at < now) throw new DeliverySurveyError('token_expired')

  const hasProblem = isProblemSurvey(score, arrivedGood, contactReason)

  let supportTicketResult: { ticketId: string; publicRef: string; created: boolean; url: string } | null = null

  if (hasProblem) {
    // Check if an existing ticket for this order already exists (deduplication)
    const existingTicket = await database
      .prepare(
        `SELECT id, public_ref FROM support_tickets
         WHERE (order_id = ? OR declared_order_reference = ?)
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(invitation.order_id, invitation.order_id)
      .first<{ id: string; public_ref: string }>()

    if (existingTicket) {
      supportTicketResult = {
        ticketId: existingTicket.id,
        publicRef: existingTicket.public_ref,
        created: false,
        url: `/soporte/${existingTicket.public_ref}`
      }
    } else {
      // Create new support ticket linked to order
      const ticketId = crypto.randomUUID()
      const publicRef = 'SOP-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()
      const commandId = crypto.randomUUID()
      const nonce = crypto.randomUUID()
      const customerId = invitation.order_customer_id

      const ticketSubject = `Incidencia en entrega de pedido ${invitation.order_id.slice(0, 8)}`
      const reasonLabel = contactReason ? CONTACT_REASON_LABELS[contactReason] : 'Incidencia reportada en entrega'
      const messageBody = comment
        ? `${reasonLabel}. Comentarios del cliente: ${comment}`
        : `${reasonLabel}. Puntuación: ${score}/5. ¿Llegó bien?: ${arrivedGood ? 'Sí' : 'No'}.`

      const requesterJson = canonicalJson({
        name: invitation.contact_name || 'Cliente',
        email: invitation.recipient_email,
        phone: invitation.contact_phone || null
      })

      const commandInput = canonicalJson({
        action: 'created',
        orderId: customerId ? invitation.order_id : null,
        orderReference: invitation.order_id,
        category: 'shipping',
        subject: ticketSubject,
        message: messageBody,
        name: invitation.contact_name || 'Cliente',
        email: invitation.recipient_email
      })

      const commandSnapshot = canonicalJson({
        priority: 'high',
        customerId,
        orderId: customerId ? invitation.order_id : null
      })

      const commandResponse = canonicalJson({
        commandId,
        publicRef,
        version: 1,
        state: 'open',
        inventoryEffect: 'none',
        economicEffect: 'none'
      })

      const payloadHash = await sha256Hex(commandInput)

      try {
        await database.batch([
          database
            .prepare(
              `INSERT INTO support_commands (id, nonce, actor_key, actor_type, ticket_id, public_ref, action, idempotency_key, payload_hash, input, snapshot, expected_version, result_version, to_state, response, created_at)
               VALUES (?, ?, ?, 'anonymous', ?, ?, 'created', ?, ?, ?, ?, 0, 1, 'open', ?, ?)`
            )
            .bind(
              commandId,
              nonce,
              'anonymous:survey:' + invitation.id,
              ticketId,
              publicRef,
              'survey-ticket-' + invitation.id,
              payloadHash,
              commandInput,
              commandSnapshot,
              commandResponse,
              now
            ),
          database
            .prepare(
              `INSERT INTO support_tickets (id, public_ref, customer_id, order_id, category, subject, requester, declared_order_reference, state, priority, version, last_command_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'shipping', ?, ?, ?, 'open', 'high', 1, ?, ?, ?)`
            )
            .bind(
              ticketId,
              publicRef,
              customerId,
              customerId ? invitation.order_id : null,
              ticketSubject,
              requesterJson,
              invitation.order_id,
              commandId,
              now,
              now
            ),
          database
            .prepare(
              `INSERT INTO support_events (id, ticket_id, actor_type, type, visibility, body, state, created_at)
               VALUES (?, ?, 'anonymous', 'created', 'public', ?, 'open', ?)`
            )
            .bind(commandId, ticketId, messageBody, now)
        ])

        supportTicketResult = {
          ticketId,
          publicRef,
          created: true,
          url: `/soporte/${publicRef}`
        }
      } catch {
        // Non-blocking: failure in support ticket insertion must not block survey response submission
      }
    }
  }

  const responseId = crypto.randomUUID()
  try {
    await database
      .prepare(
        `INSERT INTO delivery_survey_responses
         (id, invitation_id, order_id, score, arrived_good, contact_reason, comment, customer_segment, has_problem, support_ticket_id, support_ticket_public_ref, submitted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        responseId,
        invitation.id,
        invitation.order_id,
        score,
        arrivedGood ? 1 : 0,
        contactReason,
        comment,
        invitation.customer_segment,
        hasProblem ? 1 : 0,
        supportTicketResult?.ticketId ?? null,
        supportTicketResult?.publicRef ?? null,
        now,
        now
      )
      .run()
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError)
    if (
      msg.includes('delivery_survey_token_invalid_or_used') ||
      msg.includes('delivery_survey_responses.invitation_id') ||
      msg.includes('UNIQUE constraint failed')
    ) {
      throw new DeliverySurveyError('token_used')
    }
    throw dbError
  }

  return {
    ok: true,
    responseId,
    hasProblem,
    supportTicket: supportTicketResult
  }
}

/**
 * Opts out of delivery surveys by token or email.
 */
export async function optOutDeliverySurvey(
  database: D1Database,
  input: { token?: string; email?: string; reason?: string },
  options?: { now?: string }
): Promise<{ ok: boolean; optedOut: boolean }> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let email = input.email

  if (!email && input.token) {
    const inv = await database
      .prepare('SELECT recipient_email, customer_id FROM delivery_survey_invitations WHERE token = ?')
      .bind(input.token)
      .first<{ recipient_email: string; customer_id: string | null }>()
    if (inv) {
      email = inv.recipient_email
    }
  }

  if (!email || !email.includes('@')) {
    throw new DeliverySurveyError('invalid_input')
  }

  const emailHash = await sha256Hex(email.toLowerCase().trim())
  const reason = input.reason === 'customer_request' ? 'customer_request' : 'unsubscribe_link'

  await database
    .prepare(
      `INSERT INTO delivery_survey_opt_outs (email_hash, opted_out_at, reason)
       VALUES (?, ?, ?)
       ON CONFLICT(email_hash) DO NOTHING`
    )
    .bind(emailHash, now, reason)
    .run()

  return { ok: true, optedOut: true }
}

/**
 * Reads admin dashboard aggregates with sample threshold protection.
 */
export async function readAdminDeliverySurveys(
  database: D1Database,
  query: AdminDeliverySurveysQuery
): Promise<AdminDeliverySurveysDashboard> {
  const threshold = query.minSampleThreshold ?? 10
  const segment = query.segment && query.segment !== 'all' ? query.segment : null
  const contactReason = query.contactReason && query.contactReason !== 'all' ? query.contactReason : null
  const from = query.from ?? null
  const to = query.to ?? null
  const page = query.page && query.page > 0 ? query.page : 1
  const perPage = query.perPage && query.perPage > 0 && query.perPage <= 100 ? query.perPage : 25

  // 1. Invitations count
  let invSql = 'SELECT count(*) as count FROM delivery_survey_invitations WHERE 1=1'
  const invBinds: unknown[] = []
  if (from) {
    invSql += ' AND scheduled_at >= ?'
    invBinds.push(from)
  }
  if (to) {
    invSql += ' AND scheduled_at <= ?'
    invBinds.push(to)
  }
  if (segment) {
    invSql += ' AND customer_segment = ?'
    invBinds.push(segment)
  }
  const totalInvitationsRow = await database
    .prepare(invSql)
    .bind(...invBinds)
    .first<{ count: number }>()
  const totalInvitations = totalInvitationsRow?.count ?? 0

  // 2. Responses summary & metrics
  let respSql = `
    SELECT
      count(*) as count,
      coalesce(sum(score), 0) as sum_score,
      coalesce(sum(arrived_good), 0) as arrived_good_count,
      coalesce(sum(has_problem), 0) as problem_count,
      coalesce(sum(CASE WHEN support_ticket_public_ref IS NOT NULL THEN 1 ELSE 0 END), 0) as tickets_count
    FROM delivery_survey_responses
    WHERE 1=1`
  const respBinds: unknown[] = []
  if (from) {
    respSql += ' AND submitted_at >= ?'
    respBinds.push(from)
  }
  if (to) {
    respSql += ' AND submitted_at <= ?'
    respBinds.push(to)
  }
  if (segment) {
    respSql += ' AND customer_segment = ?'
    respBinds.push(segment)
  }
  if (contactReason) {
    respSql += ' AND contact_reason = ?'
    respBinds.push(contactReason)
  }

  const summaryRow = await database
    .prepare(respSql)
    .bind(...respBinds)
    .first<{
      count: number
      sum_score: number
      arrived_good_count: number
      problem_count: number
      tickets_count: number
    }>()

  const completedSurveys = summaryRow?.count ?? 0
  const hasSufficientSample = completedSurveys >= threshold

  const averageScore =
    hasSufficientSample && completedSurveys > 0
      ? Math.round((Number(summaryRow!.sum_score) / completedSurveys) * 100) / 100
      : null

  const arrivedGoodRate =
    hasSufficientSample && completedSurveys > 0
      ? Math.round((Number(summaryRow!.arrived_good_count) / completedSurveys) * 1000) / 1000
      : null

  const problemRate =
    hasSufficientSample && completedSurveys > 0
      ? Math.round((Number(summaryRow!.problem_count) / completedSurveys) * 1000) / 1000
      : null

  const responseRate =
    hasSufficientSample && totalInvitations > 0 ? Math.round((completedSurveys / totalInvitations) * 1000) / 1000 : null

  // 3. Segment Breakdown
  const segmentStatsSql = `
    SELECT
      customer_segment,
      count(*) as count,
      coalesce(sum(score), 0) as sum_score,
      coalesce(sum(arrived_good), 0) as arrived_good_count,
      coalesce(sum(has_problem), 0) as problem_count
    FROM delivery_survey_responses
    WHERE 1=1
    ${from ? 'AND submitted_at >= ?' : ''}
    ${to ? 'AND submitted_at <= ?' : ''}
    GROUP BY customer_segment`
  const segBinds: unknown[] = []
  if (from) segBinds.push(from)
  if (to) segBinds.push(to)

  const segRows = await database
    .prepare(segmentStatsSql)
    .bind(...segBinds)
    .all<{
      customer_segment: string
      count: number
      sum_score: number
      arrived_good_count: number
      problem_count: number
    }>()

  const segmentMap: Record<CustomerSegment, { count: number; sum_score: number; arrived: number; problem: number }> = {
    particular: { count: 0, sum_score: 0, arrived: 0, problem: 0 },
    profesional: { count: 0, sum_score: 0, arrived: 0, problem: 0 }
  }

  for (const row of segRows.results ?? []) {
    const seg = row.customer_segment as CustomerSegment
    if (segmentMap[seg]) {
      segmentMap[seg].count = row.count
      segmentMap[seg].sum_score = row.sum_score
      segmentMap[seg].arrived = row.arrived_good_count
      segmentMap[seg].problem = row.problem_count
    }
  }

  const makeSegmentSummary = (seg: CustomerSegment) => {
    const data = segmentMap[seg]
    const sampleOk = data.count >= threshold
    return {
      count: data.count,
      averageScore: sampleOk && data.count > 0 ? Math.round((data.sum_score / data.count) * 100) / 100 : null,
      arrivedGoodRate: sampleOk && data.count > 0 ? Math.round((data.arrived / data.count) * 1000) / 1000 : null,
      problemRate: sampleOk && data.count > 0 ? Math.round((data.problem / data.count) * 1000) / 1000 : null,
      hasSufficientSample: sampleOk
    }
  }

  // 4. Contact reason breakdown
  const reasonSql = `
    SELECT
      contact_reason,
      count(*) as count,
      coalesce(sum(score), 0) as sum_score
    FROM delivery_survey_responses
    WHERE contact_reason IS NOT NULL
    ${from ? 'AND submitted_at >= ?' : ''}
    ${to ? 'AND submitted_at <= ?' : ''}
    ${segment ? 'AND customer_segment = ?' : ''}
    GROUP BY contact_reason`
  const reasonBinds: unknown[] = []
  if (from) reasonBinds.push(from)
  if (to) reasonBinds.push(to)
  if (segment) reasonBinds.push(segment)

  const reasonRows = await database
    .prepare(reasonSql)
    .bind(...reasonBinds)
    .all<{
      contact_reason: string
      count: number
      sum_score: number
    }>()

  const reasonCountMap = new Map<string, { count: number; sum_score: number }>()
  for (const r of reasonRows.results ?? []) {
    reasonCountMap.set(r.contact_reason, { count: r.count, sum_score: r.sum_score })
  }

  const byReason = CONTACT_REASONS.map((r) => {
    const entry = reasonCountMap.get(r) ?? { count: 0, sum_score: 0 }
    const sampleOk = completedSurveys >= threshold
    return {
      reason: r,
      label: CONTACT_REASON_LABELS[r],
      count: entry.count,
      percentage: sampleOk && completedSurveys > 0 ? Math.round((entry.count / completedSurveys) * 1000) / 1000 : null,
      averageScore: entry.count > 0 ? Math.round((entry.sum_score / entry.count) * 100) / 100 : null,
      hasSufficientSample: sampleOk
    }
  })

  // 5. Score distribution
  const scoreSql = `
    SELECT score, count(*) as count
    FROM delivery_survey_responses
    WHERE 1=1
    ${from ? 'AND submitted_at >= ?' : ''}
    ${to ? 'AND submitted_at <= ?' : ''}
    ${segment ? 'AND customer_segment = ?' : ''}
    GROUP BY score`
  const scoreBinds: unknown[] = []
  if (from) scoreBinds.push(from)
  if (to) scoreBinds.push(to)
  if (segment) scoreBinds.push(segment)

  const scoreRows = await database
    .prepare(scoreSql)
    .bind(...scoreBinds)
    .all<{ score: number; count: number }>()

  const scoreDistribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const s of scoreRows.results ?? []) {
    const sc = s.score as 1 | 2 | 3 | 4 | 5
    if (sc >= 1 && sc <= 5) {
      scoreDistribution[sc] = s.count
    }
  }

  // 6. Recent responses list (paginated)
  const offset = (page - 1) * perPage
  const itemsSql = `
    SELECT
      r.id, r.order_id, r.score, r.arrived_good,
      r.contact_reason, r.customer_segment, r.has_problem,
      r.support_ticket_public_ref, r.submitted_at
    FROM delivery_survey_responses r
    JOIN orders o ON o.id = r.order_id
    WHERE 1=1
    ${from ? 'AND r.submitted_at >= ?' : ''}
    ${to ? 'AND r.submitted_at <= ?' : ''}
    ${segment ? 'AND r.customer_segment = ?' : ''}
    ${contactReason ? 'AND r.contact_reason = ?' : ''}
    ORDER BY r.submitted_at DESC
    LIMIT ? OFFSET ?`
  const itemsBinds = [...respBinds, perPage, offset]

  const itemsRows = await database
    .prepare(itemsSql)
    .bind(...itemsBinds)
    .all<Record<string, unknown>>()

  const items = (itemsRows.results ?? []).map((row) => ({
    id: String(row.id),
    orderId: String(row.order_id),
    orderNumber: String(row.order_id).slice(0, 8).toUpperCase(),
    score: Number(row.score),
    arrivedGood: Boolean(row.arrived_good),
    contactReason: row.contact_reason ? (row.contact_reason as ContactReason) : null,
    customerSegment: row.customer_segment as CustomerSegment,
    hasProblem: Boolean(row.has_problem),
    supportTicketPublicRef: row.support_ticket_public_ref ? String(row.support_ticket_public_ref) : null,
    submittedAt: String(row.submitted_at)
  }))

  return {
    period: { from, to },
    minSampleThreshold: threshold,
    summary: {
      totalInvitations,
      completedSurveys,
      responseRate,
      averageScore,
      arrivedGoodRate,
      problemRate,
      totalTicketsCreated: summaryRow?.tickets_count ?? 0,
      hasSufficientSample
    },
    bySegment: {
      particular: makeSegmentSummary('particular'),
      profesional: makeSegmentSummary('profesional')
    },
    byReason,
    scoreDistribution,
    items,
    pagination: {
      page,
      perPage,
      total: completedSurveys
    }
  }
}
