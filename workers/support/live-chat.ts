import { sha256Hex } from '../catalog/inventory'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  SUPPORT_CHAT_DISCLAIMER,
  isSupportChatOperatingHours,
  estimateWaitSeconds,
  supportChatCreateInputSchema,
  supportChatClaimInputSchema,
  supportChatHandoffInputSchema,
  supportChatEscalateInputSchema,
  supportChatCloseInputSchema,
  type SupportChatContext
} from '../../shared/support-live-chat'
import { createSupportTicket } from './operations'

export { SUPPORT_CHAT_DISCLAIMER, isSupportChatOperatingHours }

export interface LiveChatOptions {
  now?: string
  claims?: VerifiedSessionClaims | null
}

export interface LiveChatSessionRecord {
  id: string
  publicRef: string
  customerId: string | null
  status: string
  department: string
  operatorId: string | null
  operatorName: string | null
  consentGivenAt: string
  consentPolicyHash: string
  context: SupportChatContext
  currentVersion: number
  createdAt: string
  claimedAt: string | null
  closedAt: string | null
  closureReason: string | null
  ticketId: string | null
  waitedSeconds: number | null
  durationSeconds: number | null
  queuePosition?: number
  estimatedWaitSeconds?: number
  isHumanOnlyNotice?: string
}

export interface LiveChatMessageRecord {
  id: string
  sessionId: string
  sequence: number
  senderType: 'customer' | 'operator' | 'system'
  senderId: string | null
  senderName: string
  isHuman: number
  message: string
  createdAt: string
}

interface SessionDbRow {
  id: string
  public_ref: string
  customer_id: string | null
  guest_token_hash: string | null
  status: string
  department: string
  operator_id: string | null
  operator_name: string | null
  consent_given_at: string
  consent_policy_hash: string
  context_json: string
  current_version: number
  created_at: string
  claimed_at: string | null
  closed_at: string | null
  closure_reason: string | null
  ticket_id: string | null
  waited_seconds: number | null
  duration_seconds: number | null
}

interface MessageDbRow {
  id: string
  session_id: string
  sequence: number
  sender_type: 'customer' | 'operator' | 'system'
  sender_id: string | null
  sender_name: string
  is_human: number
  message: string
  created_at: string
}

function canonicalIso(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function generatePublicRef(): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 19).toUpperCase()
  return `CHAT-${hex}`
}

function extractNow(options: LiveChatOptions, rawInput: unknown): string {
  if (options.now) return canonicalIso(options.now)
  if (typeof rawInput === 'object' && rawInput !== null && 'now' in rawInput) {
    const rawNow = (rawInput as { now?: unknown }).now
    if (typeof rawNow === 'string') return canonicalIso(rawNow)
  }
  return canonicalIso()
}

export async function requestLiveChatSession(
  database: D1Database,
  rawInput: unknown,
  options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord> {
  const now = extractNow(options, rawInput)
  const input = supportChatCreateInputSchema.safeParse(rawInput)

  if (!input.success) {
    const consentErr = input.error.issues.find((i) => i.path.includes('consentGiven'))
    if (consentErr) throw new Error('consent_required')
    throw new Error('invalid_input')
  }

  const { consentPolicyHash, department, customerName, initialMessage, context } = input.data

  const operating = isSupportChatOperatingHours(now)
  if (!operating.isOpen) {
    throw new Error('outside_business_hours')
  }

  let customerId: string | null = null
  if (options.claims) {
    const authRow = await database
      .prepare('SELECT customer_id FROM identities WHERE id = ?1')
      .bind(options.claims.identityId)
      .first<{ customer_id: string | null }>()
    if (authRow) customerId = authRow.customer_id
  }

  // Count pending queue sessions
  const queueRow = await database
    .prepare("SELECT COUNT(*) AS cnt FROM support_live_chat_sessions WHERE status = 'waiting_operator'")
    .first<{ cnt: number }>()
  const queueLength = queueRow?.cnt ?? 0
  const queuePosition = queueLength + 1
  const estimatedWait = estimateWaitSeconds(queuePosition)

  const id = crypto.randomUUID()
  const publicRef = generatePublicRef()
  const contextJson = JSON.stringify(context ?? {})

  await database
    .prepare(
      `INSERT INTO support_live_chat_sessions (
        id, public_ref, customer_id, status, department,
        consent_given_at, consent_policy_hash, context_json,
        current_version, created_at
      ) VALUES (?1, ?2, ?3, 'waiting_operator', ?4, ?5, ?6, ?7, 1, ?8)`
    )
    .bind(id, publicRef, customerId, department, now, consentPolicyHash, contextJson, now)
    .run()

  // Insert initial message if provided
  if (initialMessage && initialMessage.trim().length > 0) {
    const msgId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO support_live_chat_messages (
          id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
        ) VALUES (?1, ?2, 1, 'customer', ?3, ?4, 1, ?5, ?6)`
      )
      .bind(msgId, id, options.claims?.identityId ?? null, customerName ?? 'Cliente', initialMessage.trim(), now)
      .run()
  }

  // Record command audit
  const cmdId = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify({ action: 'request', id, publicRef }))
  await database
    .prepare(
      `INSERT INTO support_live_chat_commands (
        id, session_id, actor_id, action, expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'request', 0, 1, ?4, ?5, ?6, ?7)`
    )
    .bind(
      cmdId,
      id,
      options.claims?.identityId ?? null,
      payloadHash,
      JSON.stringify(input.data),
      JSON.stringify({ id, publicRef, status: 'waiting_operator' }),
      now
    )
    .run()

  return {
    id,
    publicRef,
    customerId,
    status: 'waiting_operator',
    department,
    operatorId: null,
    operatorName: null,
    consentGivenAt: now,
    consentPolicyHash,
    context: context ?? {},
    currentVersion: 1,
    createdAt: now,
    claimedAt: null,
    closedAt: null,
    closureReason: null,
    ticketId: null,
    waitedSeconds: null,
    durationSeconds: null,
    queuePosition,
    estimatedWaitSeconds: estimatedWait,
    isHumanOnlyNotice: SUPPORT_CHAT_DISCLAIMER
  }
}

export async function claimLiveChatSession(
  database: D1Database,
  claims: VerifiedSessionClaims,
  sessionId: string,
  rawInput: unknown,
  options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = supportChatClaimInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { expectedVersion, operatorName } = parsed.data

  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')
  if (session.current_version !== expectedVersion) throw new Error('version_conflict')
  if (session.status !== 'waiting_operator' && session.status !== 'transferred') {
    throw new Error('invalid_transition')
  }

  const createdTime = new Date(session.created_at).getTime()
  const claimedTime = new Date(now).getTime()
  const waitedSeconds = Math.max(0, Math.floor((claimedTime - createdTime) / 1000))
  const newVersion = expectedVersion + 1

  await database
    .prepare(
      `UPDATE support_live_chat_sessions
       SET status = 'in_progress', operator_id = ?1, operator_name = ?2, claimed_at = ?3,
           current_version = ?4, waited_seconds = ?5
       WHERE id = ?6 AND current_version = ?7`
    )
    .bind(claims.identityId, operatorName, now, newVersion, waitedSeconds, sessionId, expectedVersion)
    .run()

  // Add system banner message
  const seqRow = await database
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM support_live_chat_messages WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ max_seq: number }>()
  const nextSeq = (seqRow?.max_seq ?? 0) + 1

  await database
    .prepare(
      `INSERT INTO support_live_chat_messages (
        id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
      ) VALUES (?1, ?2, ?3, 'system', ?4, 'Sistema Neteco', 0, ?5, ?6)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      nextSeq,
      claims.identityId,
      `El operador humano ${operatorName} se ha unido a la conversación.`,
      now
    )
    .run()

  // Audit
  const payloadHash = await sha256Hex(JSON.stringify({ action: 'claim', sessionId, expectedVersion }))
  await database
    .prepare(
      `INSERT INTO support_live_chat_commands (
        id, session_id, actor_id, action, expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'claim', ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      claims.identityId,
      expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify({ status: 'in_progress', operatorId: claims.identityId, operatorName }),
      now
    )
    .run()

  return {
    id: session.id,
    publicRef: session.public_ref,
    customerId: session.customer_id,
    status: 'in_progress',
    department: session.department,
    operatorId: claims.identityId,
    operatorName,
    consentGivenAt: session.consent_given_at,
    consentPolicyHash: session.consent_policy_hash,
    context: JSON.parse(session.context_json || '{}') as SupportChatContext,
    currentVersion: newVersion,
    createdAt: session.created_at,
    claimedAt: now,
    closedAt: session.closed_at,
    closureReason: session.closure_reason,
    ticketId: session.ticket_id,
    waitedSeconds,
    durationSeconds: session.duration_seconds
  }
}

export async function sendLiveChatMessage(
  database: D1Database,
  sessionId: string,
  input: {
    senderType: 'customer' | 'operator'
    senderId?: string | null
    senderName: string
    message: string
    now?: string
  }
): Promise<LiveChatMessageRecord> {
  const now = canonicalIso(input.now)
  const session = await database
    .prepare('SELECT id, status FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<{ id: string; status: string }>()

  if (!session) throw new Error('not_found')
  if (['resolved', 'closed', 'escalated_ticket', 'expired_inactivity'].includes(session.status)) {
    throw new Error('session_closed')
  }

  const seqRow = await database
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM support_live_chat_messages WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ max_seq: number }>()
  const sequence = (seqRow?.max_seq ?? 0) + 1
  const id = crypto.randomUUID()

  await database
    .prepare(
      `INSERT INTO support_live_chat_messages (
        id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`
    )
    .bind(
      id,
      sessionId,
      sequence,
      input.senderType,
      input.senderId ?? null,
      input.senderName,
      input.message.trim(),
      now
    )
    .run()

  return {
    id,
    sessionId,
    sequence,
    senderType: input.senderType,
    senderId: input.senderId ?? null,
    senderName: input.senderName,
    isHuman: 1,
    message: input.message.trim(),
    createdAt: now
  }
}

export async function handoffLiveChatSession(
  database: D1Database,
  claims: VerifiedSessionClaims,
  sessionId: string,
  rawInput: unknown,
  options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = supportChatHandoffInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { expectedVersion, targetDepartment, targetOperatorId, note } = parsed.data

  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')
  if (session.current_version !== expectedVersion) throw new Error('version_conflict')

  const newDepartment = targetDepartment ?? session.department
  const newVersion = expectedVersion + 1

  await database
    .prepare(
      `UPDATE support_live_chat_sessions
       SET status = 'transferred', department = ?1, operator_id = ?2, operator_name = NULL,
           current_version = ?3
       WHERE id = ?4 AND current_version = ?5`
    )
    .bind(newDepartment, targetOperatorId ?? null, newVersion, sessionId, expectedVersion)
    .run()

  const seqRow = await database
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM support_live_chat_messages WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ max_seq: number }>()
  const nextSeq = (seqRow?.max_seq ?? 0) + 1

  await database
    .prepare(
      `INSERT INTO support_live_chat_messages (
        id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
      ) VALUES (?1, ?2, ?3, 'system', ?4, 'Sistema Neteco', 0, ?5, ?6)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      nextSeq,
      claims.identityId,
      `Chat transferido al departamento ${newDepartment}. Motivo: ${note}`,
      now
    )
    .run()

  const payloadHash = await sha256Hex(JSON.stringify({ action: 'handoff', sessionId, expectedVersion, note }))
  await database
    .prepare(
      `INSERT INTO support_live_chat_commands (
        id, session_id, actor_id, action, expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'handoff', ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      claims.identityId,
      expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify({ status: 'transferred', department: newDepartment }),
      now
    )
    .run()

  return {
    id: session.id,
    publicRef: session.public_ref,
    customerId: session.customer_id,
    status: 'transferred',
    department: newDepartment,
    operatorId: targetOperatorId ?? null,
    operatorName: null,
    consentGivenAt: session.consent_given_at,
    consentPolicyHash: session.consent_policy_hash,
    context: JSON.parse(session.context_json || '{}') as SupportChatContext,
    currentVersion: newVersion,
    createdAt: session.created_at,
    claimedAt: session.claimed_at,
    closedAt: session.closed_at,
    closureReason: session.closure_reason,
    ticketId: session.ticket_id,
    waitedSeconds: session.waited_seconds,
    durationSeconds: session.duration_seconds
  }
}

export async function escalateLiveChatToTicket(
  database: D1Database,
  claims: VerifiedSessionClaims,
  sessionId: string,
  rawInput: unknown,
  options: LiveChatOptions = {}
): Promise<{ status: string; ticketId: string; ticketRef: string }> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = supportChatEscalateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { expectedVersion, category, summary } = parsed.data

  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')
  if (session.current_version !== expectedVersion) throw new Error('version_conflict')

  const context = JSON.parse(session.context_json || '{}') as Record<string, string | undefined>
  const ticketInput: Record<string, unknown> = {
    name: session.operator_name ?? 'Operador Soporte Neteco',
    email: 'soporte@neteco.es',
    category: category ?? 'other',
    subject: `Escalado chat ${session.public_ref}: ${summary.slice(0, 60)}`.trim(),
    message:
      `Incidencia escalada desde chat en vivo ${session.public_ref}.\n\nResumen: ${summary}\n\nContexto: ${session.context_json}`.trim(),
    privacyAcknowledged: true,
    website: ''
  }
  if (context.productSlug) ticketInput.productSlug = context.productSlug
  if (context.categorySlug) ticketInput.categorySlug = context.categorySlug

  const ticketReceipt = await createSupportTicket(
    database,
    {
      kind: 'admin',
      claims,
      customerId: session.customer_id,
      key: 'identity:' + claims.identityId
    },
    ticketInput,
    {
      idempotencyKey: crypto.randomUUID(),
      now
    }
  )

  const ticketRow = await database
    .prepare('SELECT id FROM support_tickets WHERE public_ref = ?1')
    .bind(ticketReceipt.publicRef)
    .first<{ id: string }>()
  const ticketId = ticketRow?.id ?? crypto.randomUUID()

  const newVersion = expectedVersion + 1
  await database
    .prepare(
      `UPDATE support_live_chat_sessions
       SET status = 'escalated_ticket', ticket_id = ?1, current_version = ?2, closed_at = ?3,
           closure_reason = 'escalated_to_ticket'
       WHERE id = ?4 AND current_version = ?5`
    )
    .bind(ticketId, newVersion, now, sessionId, expectedVersion)
    .run()

  const seqRow = await database
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM support_live_chat_messages WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ max_seq: number }>()
  const nextSeq = (seqRow?.max_seq ?? 0) + 1

  await database
    .prepare(
      `INSERT INTO support_live_chat_messages (
        id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
      ) VALUES (?1, ?2, ?3, 'system', ?4, 'Sistema Neteco', 0, ?5, ?6)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      nextSeq,
      claims.identityId,
      `Conversación escalada a ticket de soporte oficial con referencia ${ticketReceipt.publicRef}.`,
      now
    )
    .run()

  const payloadHash = await sha256Hex(JSON.stringify({ action: 'escalate', sessionId, ticketId }))
  await database
    .prepare(
      `INSERT INTO support_live_chat_commands (
        id, session_id, actor_id, action, expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'escalate', ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      claims.identityId,
      expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify({ status: 'escalated_ticket', ticketId, ticketRef: ticketReceipt.publicRef }),
      now
    )
    .run()

  return {
    status: 'escalated_ticket',
    ticketId,
    ticketRef: ticketReceipt.publicRef
  }
}

export async function closeLiveChatSession(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  sessionId: string,
  rawInput: unknown,
  options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord> {
  const now = extractNow(options, rawInput)
  if (claims) {
    const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
    if (!auth.allowed) throw new Error(auth.code)
  }

  const parsed = supportChatCloseInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { expectedVersion, closureReason, resolutionSummary } = parsed.data

  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')
  if (session.current_version !== expectedVersion) throw new Error('version_conflict')

  const startTime = new Date(session.claimed_at ?? session.created_at).getTime()
  const endTime = new Date(now).getTime()
  const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000))

  const newStatus = closureReason === 'resolved' ? 'resolved' : 'closed'
  const newVersion = expectedVersion + 1

  await database
    .prepare(
      `UPDATE support_live_chat_sessions
       SET status = ?1, closed_at = ?2, closure_reason = ?3, duration_seconds = ?4,
           current_version = ?5
       WHERE id = ?6 AND current_version = ?7`
    )
    .bind(newStatus, now, closureReason, durationSeconds, newVersion, sessionId, expectedVersion)
    .run()

  const seqRow = await database
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM support_live_chat_messages WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ max_seq: number }>()
  const nextSeq = (seqRow?.max_seq ?? 0) + 1

  await database
    .prepare(
      `INSERT INTO support_live_chat_messages (
        id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
      ) VALUES (?1, ?2, ?3, 'system', ?4, 'Sistema Neteco', 0, ?5, ?6)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      nextSeq,
      claims?.identityId ?? null,
      `Chat finalizado (${closureReason}). ${resolutionSummary ?? ''}`.trim(),
      now
    )
    .run()

  const payloadHash = await sha256Hex(JSON.stringify({ action: 'close', sessionId, closureReason }))
  await database
    .prepare(
      `INSERT INTO support_live_chat_commands (
        id, session_id, actor_id, action, expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'close', ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      sessionId,
      claims?.identityId ?? null,
      expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify({ status: newStatus, durationSeconds }),
      now
    )
    .run()

  return {
    id: session.id,
    publicRef: session.public_ref,
    customerId: session.customer_id,
    status: newStatus,
    department: session.department,
    operatorId: session.operator_id,
    operatorName: session.operator_name,
    consentGivenAt: session.consent_given_at,
    consentPolicyHash: session.consent_policy_hash,
    context: JSON.parse(session.context_json || '{}') as SupportChatContext,
    currentVersion: newVersion,
    createdAt: session.created_at,
    claimedAt: session.claimed_at,
    closedAt: now,
    closureReason,
    ticketId: session.ticket_id,
    waitedSeconds: session.waited_seconds,
    durationSeconds
  }
}

export async function readLiveChatSession(
  database: D1Database,
  sessionId: string,
  _options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord> {
  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')

  return {
    id: session.id,
    publicRef: session.public_ref,
    customerId: session.customer_id,
    status: session.status,
    department: session.department,
    operatorId: session.operator_id,
    operatorName: session.operator_name,
    consentGivenAt: session.consent_given_at,
    consentPolicyHash: session.consent_policy_hash,
    context: JSON.parse(session.context_json || '{}') as SupportChatContext,
    currentVersion: session.current_version,
    createdAt: session.created_at,
    claimedAt: session.claimed_at,
    closedAt: session.closed_at,
    closureReason: session.closure_reason,
    ticketId: session.ticket_id,
    waitedSeconds: session.waited_seconds,
    durationSeconds: session.duration_seconds
  }
}

export async function readLiveChatTranscript(
  database: D1Database,
  sessionId: string
): Promise<{
  sessionId: string
  sessionRef: string
  status: string
  department: string
  consent: { givenAt: string; policyHash: string }
  context: SupportChatContext
  messages: LiveChatMessageRecord[]
}> {
  const session = await database
    .prepare('SELECT * FROM support_live_chat_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<SessionDbRow>()

  if (!session) throw new Error('not_found')

  const messagesResult = await database
    .prepare(
      `SELECT id, session_id, sequence, sender_type, sender_id, sender_name, is_human, message, created_at
       FROM support_live_chat_messages
       WHERE session_id = ?1
       ORDER BY sequence ASC`
    )
    .bind(sessionId)
    .all<MessageDbRow>()

  const messages: LiveChatMessageRecord[] = (messagesResult.results ?? []).map((m) => ({
    id: m.id,
    sessionId: m.session_id,
    sequence: m.sequence,
    senderType: m.sender_type,
    senderId: m.sender_id,
    senderName: m.sender_name,
    isHuman: m.is_human,
    message: m.message,
    createdAt: m.created_at
  }))

  return {
    sessionId: session.id,
    sessionRef: session.public_ref,
    status: session.status,
    department: session.department,
    consent: {
      givenAt: session.consent_given_at,
      policyHash: session.consent_policy_hash
    },
    context: JSON.parse(session.context_json || '{}') as SupportChatContext,
    messages
  }
}

export async function listActiveLiveChatQueue(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: LiveChatOptions = {}
): Promise<LiveChatSessionRecord[]> {
  const now = canonicalIso(options.now)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const rows = await database
    .prepare(
      `SELECT * FROM support_live_chat_sessions
       WHERE status IN ('waiting_operator', 'in_progress', 'transferred')
       ORDER BY CASE status WHEN 'waiting_operator' THEN 1 WHEN 'transferred' THEN 2 ELSE 3 END, created_at ASC`
    )
    .all<SessionDbRow>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    publicRef: r.public_ref,
    customerId: r.customer_id,
    status: r.status,
    department: r.department,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    consentGivenAt: r.consent_given_at,
    consentPolicyHash: r.consent_policy_hash,
    context: JSON.parse(r.context_json || '{}') as SupportChatContext,
    currentVersion: r.current_version,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    closedAt: r.closed_at,
    closureReason: r.closure_reason,
    ticketId: r.ticket_id,
    waitedSeconds: r.waited_seconds,
    durationSeconds: r.duration_seconds
  }))
}
