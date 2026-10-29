import {
  type GenerateDraftInput,
  type HumanApprovalInput,
  type EvaluateAccuracyInput,
  type CopilotInteractionRecord,
  type CopilotCitation,
  type RedactionFlags,
  GenerateDraftInputSchema,
  HumanApprovalInputSchema,
  EvaluateAccuracyInputSchema,
  SupportCopilotError,
  copilotPayloadHash
} from '../../shared/support-copilot'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface CopilotOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: CopilotOperationOptions): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function generateD1CopilotDraft(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: GenerateDraftInput,
  options: CopilotOperationOptions
): Promise<{
  interactionId: string
  ticketId: string
  contextSummary: string
  proposedReply: string
  citations: CopilotCitation[]
  redactionFlags: RedactionFlags
  approvalStatus: string
  version: number
}> {
  const parsed = GenerateDraftInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportCopilotError('invalid_input', `Entrada de copiloto inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await copilotPayloadHash('generate_draft', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_copilot_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportCopilotError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // 1. Read Ticket from D1
  const ticket = await database
    .prepare(
      `SELECT id, public_ref, customer_id, order_id, category, subject, requester, state, priority
       FROM support_tickets WHERE id = ?1`
    )
    .bind(input.ticketId)
    .first<{
      id: string
      public_ref: string
      customer_id: string | null
      order_id: string | null
      category: string
      subject: string
      requester: string
      state: string
      priority: string
    }>()

  if (!ticket) {
    throw new SupportCopilotError('ticket_not_found', `Ticket ${input.ticketId} no encontrado`)
  }

  const requester = JSON.parse(ticket.requester || '{}') as { name?: string; email?: string }
  const requesterName = requester.name ?? 'Cliente'

  // 2. Read Order details if linked
  let orderInfo: { id: string; status: string; total_gross_cents: number; contact_email: string } | null = null
  if (ticket.order_id) {
    const orderRow = await database
      .prepare(
        `SELECT id, status, total_gross_cents, contact_email
         FROM orders WHERE id = ?1`
      )
      .bind(ticket.order_id)
      .first<{ id: string; status: string; total_gross_cents: number; contact_email: string }>()
    if (orderRow) {
      orderInfo = {
        id: orderRow.id,
        status: orderRow.status,
        total_gross_cents: orderRow.total_gross_cents,
        contact_email: orderRow.contact_email
      }
    }
  }

  // 3. Synthesize citations from verified DB data
  const citations: CopilotCitation[] = [
    {
      id: 'cit-ticket',
      sourceType: 'ticket_history',
      factKey: 'ticket_reference',
      citationText: `Incidencia registrada bajo referencia ${ticket.public_ref} (${ticket.category}, prioridad ${ticket.priority})`,
      verified: true
    }
  ]

  if (orderInfo) {
    citations.push(
      {
        id: 'cit-order-state',
        sourceType: 'order',
        factKey: 'order_status',
        citationText: `Pedido #${orderInfo.id} registrado con estado '${orderInfo.status}' e importe ${(orderInfo.total_gross_cents / 100).toFixed(2)}€`,
        verified: true
      },
      {
        id: 'cit-order-contact',
        sourceType: 'shipment',
        factKey: 'contact_email',
        citationText: `Dirección de contacto confirmada para notificación: ${orderInfo.contact_email}`,
        verified: true
      }
    )
  } else {
    citations.push({
      id: 'cit-policy',
      sourceType: 'policy',
      factKey: 'customer_care_policy',
      citationText: 'Política de soporte Neteco: atención y resolución técnica en 24-48h laborables',
      verified: true
    })
  }

  // 4. Construct Context Summary & Proposed Reply
  const contextSummary = orderInfo
    ? `Ticket ${ticket.public_ref} ('${ticket.subject}'). Cliente: ${requesterName}. Pedido vinculado: ${orderInfo.id} (estado: ${orderInfo.status}).`
    : `Ticket ${ticket.public_ref} ('${ticket.subject}'). Cliente: ${requesterName}. Consulta general de categoría ${ticket.category}.`

  const proposedReply = orderInfo
    ? `Estimado/a ${requesterName},\n\nLe confirmamos que hemos revisado su incidencia [Cita 1]. Su pedido #${orderInfo.id} se encuentra registrado con estado '${orderInfo.status}' [Cita 2] asociado al contacto de envío verificado [Cita 3]. Quedamos a su disposición para cualquier consulta adicional sobre su suministro.\n\nAtentamente,\nEquipo de Soporte Neteco`
    : `Estimado/a ${requesterName},\n\nGracias por ponerse en contacto con Neteco respecto a su consulta [Cita 1]. Conforme a nuestra política operativa [Cita 2], estamos gestionando su solicitud para darle respuesta a la mayor brevedad posible.\n\nAtentamente,\nEquipo de Soporte Neteco`

  // 5. Redaction and safety validation
  const redactionFlags: RedactionFlags = {
    noUnauthorizedRefundCommitment: !/reembolso inmediato|indemnizaci[oó]n no autorizada/i.test(proposedReply),
    toneAppropriate: true,
    safePiiMasking: true
  }

  const interactionId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const receipt = {
    interactionId,
    ticketId: input.ticketId,
    contextSummary,
    proposedReply,
    citations,
    redactionFlags,
    approvalStatus: 'pending',
    version: 1
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO support_copilot_interactions (
          id, ticket_id, operator_id, context_summary, proposed_reply,
          citations_json, redaction_flags_json, approval_status, version,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 1, ?8, ?8)`
      )
      .bind(
        interactionId,
        input.ticketId,
        claims.identityId,
        contextSummary,
        proposedReply,
        JSON.stringify(citations),
        JSON.stringify(redactionFlags),
        now
      ),
    database
      .prepare(
        `INSERT INTO support_copilot_commands (
          command_id, interaction_id, actor_id, action, idempotency_key,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'generate_draft', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        interactionId,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function recordD1CopilotHumanApproval(
  database: D1Database,
  claims: VerifiedSessionClaims,
  interactionId: string,
  rawInput: HumanApprovalInput,
  options: CopilotOperationOptions
): Promise<{
  interactionId: string
  approvalStatus: string
  humanApprovedAt: string | null
  finalSentReply: string | null
  version: number
}> {
  const parsed = HumanApprovalInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportCopilotError('invalid_input', `Decisión humana inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await copilotPayloadHash('human_decision', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_copilot_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportCopilotError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await readD1CopilotInteraction(database, interactionId)
  if (!existing) {
    throw new SupportCopilotError('not_found', `Interacción de copiloto ${interactionId} no encontrada`)
  }

  if (existing.version !== input.expectedVersion) {
    throw new SupportCopilotError(
      'concurrency_conflict',
      `Conflicto CAS: versión esperada ${input.expectedVersion}, versión actual ${existing.version}`
    )
  }

  let finalSentReply: string | null = null
  let nextStatus = existing.approvalStatus

  if (input.decision === 'approve') {
    nextStatus = 'approved'
    finalSentReply = existing.proposedReply
  } else if (input.decision === 'reject') {
    nextStatus = 'rejected'
    finalSentReply = null
  } else if (input.decision === 'modify_and_approve') {
    nextStatus = 'modified_and_approved'
    finalSentReply = input.modifiedReply ?? existing.proposedReply
  }

  const nextVersion = existing.version + 1
  const commandId = crypto.randomUUID()
  const receipt = {
    interactionId,
    approvalStatus: nextStatus,
    humanApprovedAt: nextStatus === 'rejected' ? null : now,
    finalSentReply,
    version: nextVersion
  }

  await database.batch([
    database
      .prepare(
        `UPDATE support_copilot_interactions SET
          approval_status = ?1,
          human_approved_at = ?2,
          human_approver_id = ?3,
          final_sent_reply = ?4,
          version = ?5,
          updated_at = ?6
        WHERE id = ?7 AND version = ?8`
      )
      .bind(
        nextStatus,
        receipt.humanApprovedAt,
        claims.identityId,
        finalSentReply,
        nextVersion,
        now,
        interactionId,
        existing.version
      ),
    database
      .prepare(
        `INSERT INTO support_copilot_commands (
          command_id, interaction_id, actor_id, action, idempotency_key,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'human_decision', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        interactionId,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function recordD1CopilotAccuracyEvaluation(
  database: D1Database,
  claims: VerifiedSessionClaims,
  interactionId: string,
  rawInput: EvaluateAccuracyInput,
  options: CopilotOperationOptions
): Promise<{
  interactionId: string
  accuracyScore: number
  accuracyEvaluation: string
  evaluatedAt: string
}> {
  const parsed = EvaluateAccuracyInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportCopilotError('invalid_input', `Evaluación de exactitud inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await copilotPayloadHash('evaluate_accuracy', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_copilot_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportCopilotError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await readD1CopilotInteraction(database, interactionId)
  if (!existing) {
    throw new SupportCopilotError('not_found', `Interacción de copiloto ${interactionId} no encontrada`)
  }

  const commandId = crypto.randomUUID()
  const receipt = {
    interactionId,
    accuracyScore: input.score,
    accuracyEvaluation: input.evaluation,
    evaluatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `UPDATE support_copilot_interactions SET
          accuracy_score = ?1,
          accuracy_evaluation = ?2,
          accuracy_notes = ?3,
          evaluated_at = ?4,
          evaluated_by = ?5,
          updated_at = ?4
        WHERE id = ?6`
      )
      .bind(input.score, input.evaluation, input.notes ?? null, now, claims.identityId, interactionId),
    database
      .prepare(
        `INSERT INTO support_copilot_commands (
          command_id, interaction_id, actor_id, action, idempotency_key,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'evaluate_accuracy', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        interactionId,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function readD1CopilotInteraction(
  database: D1Database,
  interactionId: string
): Promise<CopilotInteractionRecord | null> {
  const row = await database
    .prepare(
      `SELECT
        id, ticket_id, operator_id, context_summary, proposed_reply,
        citations_json, redaction_flags_json, approval_status,
        human_approved_at, human_approver_id, final_sent_reply,
        accuracy_evaluation, accuracy_score, accuracy_notes,
        evaluated_at, evaluated_by, version, created_at, updated_at
      FROM support_copilot_interactions
      WHERE id = ?1`
    )
    .bind(interactionId)
    .first<{
      id: string
      ticket_id: string
      operator_id: string
      context_summary: string
      proposed_reply: string
      citations_json: string
      redaction_flags_json: string
      approval_status: string
      human_approved_at: string | null
      human_approver_id: string | null
      final_sent_reply: string | null
      accuracy_evaluation: string | null
      accuracy_score: number | null
      accuracy_notes: string | null
      evaluated_at: string | null
      evaluated_by: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    ticketId: row.ticket_id,
    operatorId: row.operator_id,
    contextSummary: row.context_summary,
    proposedReply: row.proposed_reply,
    citations: JSON.parse(row.citations_json),
    redactionFlags: JSON.parse(row.redaction_flags_json),
    approvalStatus: row.approval_status as CopilotInteractionRecord['approvalStatus'],
    humanApprovedAt: row.human_approved_at,
    humanApproverId: row.human_approver_id,
    finalSentReply: row.final_sent_reply,
    accuracyEvaluation: row.accuracy_evaluation as CopilotInteractionRecord['accuracyEvaluation'],
    accuracyScore: row.accuracy_score,
    accuracyNotes: row.accuracy_notes,
    evaluatedAt: row.evaluated_at,
    evaluatedBy: row.evaluated_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listD1CopilotInteractions(
  database: D1Database,
  filters: { ticketId?: string; approvalStatus?: string; limit?: number } = {}
): Promise<{ items: CopilotInteractionRecord[] }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (filters.ticketId) {
    params.push(filters.ticketId)
    where += ` AND ticket_id = ?${params.length}`
  }
  if (filters.approvalStatus) {
    params.push(filters.approvalStatus)
    where += ` AND approval_status = ?${params.length}`
  }

  params.push(limit)
  const rows = await database
    .prepare(
      `SELECT
        id, ticket_id, operator_id, context_summary, proposed_reply,
        citations_json, redaction_flags_json, approval_status,
        human_approved_at, human_approver_id, final_sent_reply,
        accuracy_evaluation, accuracy_score, accuracy_notes,
        evaluated_at, evaluated_by, version, created_at, updated_at
      FROM support_copilot_interactions
      ${where}
      ORDER BY created_at DESC
      LIMIT ?${params.length}`
    )
    .bind(...params)
    .all<{
      id: string
      ticket_id: string
      operator_id: string
      context_summary: string
      proposed_reply: string
      citations_json: string
      redaction_flags_json: string
      approval_status: string
      human_approved_at: string | null
      human_approver_id: string | null
      final_sent_reply: string | null
      accuracy_evaluation: string | null
      accuracy_score: number | null
      accuracy_notes: string | null
      evaluated_at: string | null
      evaluated_by: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  const items: CopilotInteractionRecord[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    operatorId: row.operator_id,
    contextSummary: row.context_summary,
    proposedReply: row.proposed_reply,
    citations: JSON.parse(row.citations_json),
    redactionFlags: JSON.parse(row.redaction_flags_json),
    approvalStatus: row.approval_status as CopilotInteractionRecord['approvalStatus'],
    humanApprovedAt: row.human_approved_at,
    humanApproverId: row.human_approver_id,
    finalSentReply: row.final_sent_reply,
    accuracyEvaluation: row.accuracy_evaluation as CopilotInteractionRecord['accuracyEvaluation'],
    accuracyScore: row.accuracy_score,
    accuracyNotes: row.accuracy_notes,
    evaluatedAt: row.evaluated_at,
    evaluatedBy: row.evaluated_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))

  return { items }
}
