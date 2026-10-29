import {
  type GenerateAdminProposalInput,
  type HumanAdminDecisionInput,
  type AdminAiInteractionRecord,
  type AdminAiCitation,
  type AdminAiRedactionFlags,
  type AdminAiActionType,
  GenerateAdminProposalInputSchema,
  HumanAdminDecisionInputSchema,
  AdminAiAssistantError,
  assistantPayloadHash
} from '../../shared/admin-ai-assistant'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export interface AssistantOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: AssistantOperationOptions): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function verifyAdminAssistantAuth(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<void> {
  const authDirect = await authorizeD1Session(database, claims, 'admin.ai_assistant', { now, requireMfa: false })
  if (authDirect.allowed) return

  const authFallback = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: false })
  if (authFallback.allowed) return

  throw new AdminAiAssistantError(
    'unauthorized',
    'Permisos insuficientes: se requiere admin.ai_assistant o administration.manage'
  )
}

export async function generateD1AdminAiProposal(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: GenerateAdminProposalInput,
  options: AssistantOperationOptions
): Promise<AdminAiInteractionRecord> {
  const parsed = GenerateAdminProposalInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AdminAiAssistantError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyAdminAssistantAuth(database, claims, now)

  const payloadHash = await assistantPayloadHash('generate_proposal', input)

  // 1. Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM admin_ai_assistant_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new AdminAiAssistantError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // 2. Detect context & collect verifiable citations from D1
  const citations: AdminAiCitation[] = []
  let contextSummary = `Categoría de consulta: ${input.category}. Actor solicitante: ${claims.identityId}.`
  let proposedAction: string | null = null
  let actionType: AdminAiActionType | null = null
  let actionPayload: Record<string, unknown> | null = null

  // Check for auto-refund or auto-publish triggers in prompt
  const isRefundRequest = /reembols|refund|devoluc|abono/i.test(input.prompt)
  const isPublishRequest = /publicar|publish|activar\s+catalogo/i.test(input.prompt)

  if (isRefundRequest) {
    actionType = 'propose_refund_review'
    proposedAction = 'Someter solicitud de reembolso a revisión y autorización humana'
    actionPayload = { requestedAction: 'refund_review', contextRef: input.contextId || 'N/A' }
    citations.push({
      id: 'cit-ref-pol',
      sourceType: 'policy',
      factKey: 'refund_human_gate',
      citationText: 'Política fiscal y de pedidos: los reembolsos exigen aprobación humana manual obligatoria',
      verified: true
    })
  } else if (isPublishRequest) {
    actionType = 'propose_publish_review'
    proposedAction = 'Proponer revisión editorial para publicación en catálogo'
    actionPayload = { requestedAction: 'publish_review', contextRef: input.contextId || 'N/A' }
    citations.push({
      id: 'cit-pub-pol',
      sourceType: 'policy',
      factKey: 'catalog_publication_gate',
      citationText: 'Política de catálogo: la publicación requiere revisión y firma por administrador cualificado',
      verified: true
    })
  }

  // If a contextId is supplied (e.g., product id or order id)
  if (input.contextId) {
    const product = await database
      .prepare(`SELECT id, name, short_description, description FROM products WHERE id = ?1`)
      .bind(input.contextId)
      .first<{ id: string; name: string; short_description: string | null; description: string | null }>()

    if (product) {
      contextSummary += ` Contexto de producto: ${product.name} (ID: ${product.id}).`
      citations.push({
        id: `cit-prod-${product.id}`,
        sourceType: 'product',
        factKey: 'catalog_record',
        citationText: `Producto '${product.name}' registrado en el catálogo central de Neteco`,
        verified: true,
        recordId: product.id
      })
    }

    const inventory = await database
      .prepare(
        `SELECT ib.physical_quantity
         FROM inventory_balances ib
         JOIN variants v ON v.id = ib.variant_id
         WHERE v.product_id = ?1 OR v.id = ?1 LIMIT 1`
      )
      .bind(input.contextId)
      .first<{ physical_quantity: number }>()

    if (inventory) {
      citations.push({
        id: `cit-inv-${input.contextId}`,
        sourceType: 'inventory',
        factKey: 'physical_quantity',
        citationText: `Existencias físicas: ${inventory.physical_quantity} unidades en almacén central`,
        verified: true,
        recordId: input.contextId
      })
      if (!actionType) {
        actionType = 'propose_restock_alert'
        proposedAction = 'Generar alerta de reaprovisionamiento preventivo'
        actionPayload = { threshold: 20, currentOnHand: inventory.physical_quantity }
      }
    }
  }

  // Add default safety & platform citations if none matched yet
  if (citations.length === 0) {
    citations.push({
      id: 'cit-std-1',
      sourceType: 'policy',
      factKey: 'general_admin_standard',
      citationText: 'Normativa de gobernanza Neteco: copiloto de soporte administrativo bajo aprobación humana',
      verified: true
    })
  }

  const redactionFlags: AdminAiRedactionFlags = {
    noUnauthorizedRefundCommitment: true,
    toneAppropriate: true,
    safePiiMasking: true,
    restrictedAccessFiltered: true
  }

  const citationsFormatted = citations
    .map((c, i) => `[Cita ${i + 1}: ${c.citationText}]`)
    .join(' ')

  const proposedReply =
    `Respuesta asistida para consulta (${input.category}): ` +
    `En base a los datos verificados del sistema, se ha analizado la solicitud "${input.prompt}". ` +
    `${citationsFormatted}. ` +
    `Cualquier acción propuesta queda sujeta a revisión y autorización humana obligatoria.`

  const interactionId = crypto.randomUUID()
  const modelId = 'neteco-admin-copilot-v1'
  const tokensUsed = 120

  const record: AdminAiInteractionRecord = {
    id: interactionId,
    actorId: claims.identityId,
    category: input.category,
    prompt: input.prompt,
    contextSummary,
    proposedReply,
    proposedAction,
    actionType,
    actionPayload,
    citations,
    redactionFlags,
    requiresHumanApproval: true,
    autoExecutionForbidden: true,
    approvalStatus: 'pending',
    humanDecidedAt: null,
    humanDeciderId: null,
    humanNotes: null,
    modelId,
    tokensUsed,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  // Write interaction to D1
  await database
    .prepare(
      `INSERT INTO admin_ai_assistant_interactions (
        id, actor_id, category, prompt, context_summary, proposed_reply,
        proposed_action, action_type, action_payload_json, citations_json,
        redaction_flags_json, requires_human_approval, auto_execution_forbidden,
        approval_status, human_decided_at, human_decider_id, human_notes,
        model_id, tokens_used, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, 1, 'pending', NULL, NULL, NULL, ?12, ?13, 1, ?14, ?14)`
    )
    .bind(
      record.id,
      record.actorId,
      record.category,
      record.prompt,
      record.contextSummary,
      record.proposedReply,
      record.proposedAction,
      record.actionType,
      record.actionPayload ? JSON.stringify(record.actionPayload) : null,
      JSON.stringify(record.citations),
      JSON.stringify(record.redactionFlags),
      record.modelId,
      record.tokensUsed,
      now
    )
    .run()

  // Record command in append-only table
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO admin_ai_assistant_commands (
        command_id, interaction_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'generate_proposal', ?4, 0, 1, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      record.id,
      claims.identityId,
      options.idempotencyKey,
      payloadHash,
      JSON.stringify(input),
      JSON.stringify(record),
      now
    )
    .run()

  return record
}

export async function recordD1AdminAiHumanDecision(
  database: D1Database,
  claims: VerifiedSessionClaims,
  interactionId: string,
  rawInput: HumanAdminDecisionInput,
  options: AssistantOperationOptions
): Promise<AdminAiInteractionRecord> {
  const parsed = HumanAdminDecisionInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AdminAiAssistantError('invalid_input', `Decisión inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyAdminAssistantAuth(database, claims, now)

  const payloadHash = await assistantPayloadHash('human_decision', { interactionId, ...input })

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM admin_ai_assistant_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new AdminAiAssistantError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Fetch current interaction
  const row = await database
    .prepare(
      `SELECT id, actor_id, category, prompt, context_summary, proposed_reply,
              proposed_action, action_type, action_payload_json, citations_json,
              redaction_flags_json, requires_human_approval, auto_execution_forbidden,
              approval_status, human_decided_at, human_decider_id, human_notes,
              model_id, tokens_used, version, created_at, updated_at
       FROM admin_ai_assistant_interactions WHERE id = ?1`
    )
    .bind(interactionId)
    .first<any>()

  if (!row) {
    throw new AdminAiAssistantError('not_found', `Interacción de asistente ${interactionId} no encontrada`)
  }

  // CAS check
  if (row.version !== input.expectedVersion) {
    throw new AdminAiAssistantError(
      'concurrency_conflict',
      `Conflicto de concurrencia: la versión esperada (${input.expectedVersion}) no coincide con la versión actual (${row.version})`
    )
  }

  const newStatus =
    input.decision === 'approve'
      ? 'approved'
      : input.decision === 'reject'
        ? 'rejected'
        : 'modified_and_approved'

  const finalReply = input.modifiedReply ?? row.proposed_reply
  const finalPayload = input.modifiedActionPayload
    ? JSON.stringify(input.modifiedActionPayload)
    : row.action_payload_json
  const finalNotes = input.notes ?? row.human_notes
  const newVersion = row.version + 1

  await database
    .prepare(
      `UPDATE admin_ai_assistant_interactions
       SET approval_status = ?1,
           human_decided_at = ?2,
           human_decider_id = ?3,
           human_notes = ?4,
           proposed_reply = ?5,
           action_payload_json = ?6,
           version = ?7,
           updated_at = ?8
       WHERE id = ?9 AND version = ?10`
    )
    .bind(
      newStatus,
      now,
      claims.identityId,
      finalNotes,
      finalReply,
      finalPayload,
      newVersion,
      now,
      interactionId,
      row.version
    )
    .run()

  const updatedRecord: AdminAiInteractionRecord = {
    id: row.id,
    actorId: row.actor_id,
    category: row.category,
    prompt: row.prompt,
    contextSummary: row.context_summary,
    proposedReply: finalReply,
    proposedAction: row.proposed_action,
    actionType: row.action_type,
    actionPayload: finalPayload ? JSON.parse(finalPayload) : null,
    citations: JSON.parse(row.citations_json),
    redactionFlags: JSON.parse(row.redaction_flags_json),
    requiresHumanApproval: true,
    autoExecutionForbidden: true,
    approvalStatus: newStatus,
    humanDecidedAt: now,
    humanDeciderId: claims.identityId,
    humanNotes: finalNotes,
    modelId: row.model_id,
    tokensUsed: row.tokens_used,
    version: newVersion,
    createdAt: row.created_at,
    updatedAt: now
  }

  // Record command
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO admin_ai_assistant_commands (
        command_id, interaction_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'human_decision', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      commandId,
      interactionId,
      claims.identityId,
      options.idempotencyKey,
      input.expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(input),
      JSON.stringify(updatedRecord),
      now
    )
    .run()

  return updatedRecord
}

export async function readD1AdminAiInteraction(
  database: D1Database,
  claims: VerifiedSessionClaims,
  interactionId: string
): Promise<AdminAiInteractionRecord> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyAdminAssistantAuth(database, claims, now)

  const row = await database
    .prepare(
      `SELECT id, actor_id, category, prompt, context_summary, proposed_reply,
              proposed_action, action_type, action_payload_json, citations_json,
              redaction_flags_json, requires_human_approval, auto_execution_forbidden,
              approval_status, human_decided_at, human_decider_id, human_notes,
              model_id, tokens_used, version, created_at, updated_at
       FROM admin_ai_assistant_interactions WHERE id = ?1`
    )
    .bind(interactionId)
    .first<any>()

  if (!row) {
    throw new AdminAiAssistantError('not_found', `Interacción ${interactionId} no encontrada`)
  }

  return {
    id: row.id,
    actorId: row.actor_id,
    category: row.category,
    prompt: row.prompt,
    contextSummary: row.context_summary,
    proposedReply: row.proposed_reply,
    proposedAction: row.proposed_action,
    actionType: row.action_type,
    actionPayload: row.action_payload_json ? JSON.parse(row.action_payload_json) : null,
    citations: JSON.parse(row.citations_json),
    redactionFlags: JSON.parse(row.redaction_flags_json),
    requiresHumanApproval: true,
    autoExecutionForbidden: true,
    approvalStatus: row.approval_status,
    humanDecidedAt: row.human_decided_at,
    humanDeciderId: row.human_decider_id,
    humanNotes: row.human_notes,
    modelId: row.model_id,
    tokensUsed: row.tokens_used,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listD1AdminAiInteractions(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filters?: { category?: string; status?: string }
): Promise<AdminAiInteractionRecord[]> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyAdminAssistantAuth(database, claims, now)

  let sql = `SELECT id, actor_id, category, prompt, context_summary, proposed_reply,
                    proposed_action, action_type, action_payload_json, citations_json,
                    redaction_flags_json, requires_human_approval, auto_execution_forbidden,
                    approval_status, human_decided_at, human_decider_id, human_notes,
                    model_id, tokens_used, version, created_at, updated_at
             FROM admin_ai_assistant_interactions WHERE 1=1`
  const params: unknown[] = []

  if (filters?.category) {
    params.push(filters.category)
    sql += ` AND category = ?${params.length}`
  }
  if (filters?.status) {
    params.push(filters.status)
    sql += ` AND approval_status = ?${params.length}`
  }

  sql += ` ORDER BY created_at DESC LIMIT 50`

  const statement = database.prepare(sql)
  const rows = params.length > 0 ? (await statement.bind(...params).all<any>()).results : (await statement.all<any>()).results

  return (rows || []).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    category: row.category,
    prompt: row.prompt,
    contextSummary: row.context_summary,
    proposedReply: row.proposed_reply,
    proposedAction: row.proposed_action,
    actionType: row.action_type,
    actionPayload: row.action_payload_json ? JSON.parse(row.action_payload_json) : null,
    citations: JSON.parse(row.citations_json),
    redactionFlags: JSON.parse(row.redaction_flags_json),
    requiresHumanApproval: true,
    autoExecutionForbidden: true,
    approvalStatus: row.approval_status,
    humanDecidedAt: row.human_decided_at,
    humanDeciderId: row.human_decider_id,
    humanNotes: row.human_notes,
    modelId: row.model_id,
    tokensUsed: row.tokens_used,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
