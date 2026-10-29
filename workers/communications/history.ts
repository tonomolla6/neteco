import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { supportEmailRenderers } from '../support/email'
import { supportInstant, supportUuid } from '../../shared/support-operations'
import {
  communicationEventIdSchema,
  communicationHistoryQuerySchema,
  communicationHistorySchema,
  communicationRetryInputSchema,
  communicationRetryReceiptSchema,
  communicationRetryCommandSchema,
  communicationRetryIntentHash,
  communicationTypeSchema,
  type CommunicationHistory,
  type CommunicationRetryReceipt,
  type CommunicationRetryCommand
} from '../../shared/communication-history'

export class CommunicationHistoryError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'not_retryable'
      | 'service_unavailable'
  ) {
    super(code)
  }
}
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const authority = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=${clock} AND s.expires_at>${clock}
 AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
 AND s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_roles ir JOIN role_permissions rp ON rp.role_code=ir.role_code
 WHERE ir.identity_id=i.id AND rp.permission_code='administration.manage' AND ir.granted_at<=${clock}
 AND (ir.expires_at IS NULL OR ir.expires_at>${clock}))`
const visible = `e.source_kind<>'identity' AND e.event_type IN(${communicationTypeSchema.options.map((value) => "'" + value + "'").join(',')})
 AND (e.source_kind<>'support' OR EXISTS(SELECT 1 FROM support_tickets t WHERE t.id=e.source_id
 AND t.retention_until IS NOT NULL AND t.retention_until>${clock}))`
const sourceProof = `((e.event_type='order.created' AND e.source_kind='order' AND e.schema_version=1
 AND EXISTS(SELECT 1 FROM orders o JOIN order_events occurrence ON occurrence.order_id=o.id
 WHERE o.id=e.source_id AND occurrence.id=e.source_event_id AND occurrence.event_type='order.created'
 AND o.currency='EUR' AND o.total_gross_cents>=0 AND o.shipping_gross_cents>=0
 AND length(o.contact_email) BETWEEN 3 AND 254 AND instr(o.contact_email,'@')>1
 AND (SELECT count(*) FROM order_lines l WHERE l.order_id=o.id) BETWEEN 1 AND 100
 AND NOT EXISTS(SELECT 1 FROM order_lines l WHERE l.order_id=o.id AND (l.quantity<1 OR l.gross_cents<0))))
 OR(e.source_kind='support' AND e.schema_version=1 AND e.event_type IN('support.ticket.received','support.ticket.reply')
 AND (${supportEmailRenderers[0]!.sourcePredicate})
 AND EXISTS(SELECT 1 FROM support_tickets t JOIN support_commands first ON first.ticket_id=t.id AND first.action='created'
 LEFT JOIN identities i ON i.id=first.actor_id LEFT JOIN customers c ON c.id=t.customer_id
 WHERE t.id=e.source_id AND t.retention_until IS NOT NULL AND t.retention_until>${clock}
 AND ((t.customer_id IS NULL AND length(json_extract(t.requester,'$.email')) BETWEEN 3 AND 254)
 OR(i.customer_id=t.customer_id AND i.status='active' AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=${clock} AND c.status='active')))))`
const retryable = `d.status='pending' AND d.last_error_code='preparation_failed' AND d.attempts<10
 AND d.lease_token IS NULL AND d.lease_until IS NULL AND d.sending_at IS NULL
 AND d.finished_at IS NULL AND d.provider_message_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM operational_email_suppressions x WHERE x.event_id=e.id) AND ${sourceProof}`
function binds(claims: VerifiedSessionClaims, options: { now?: string }) {
  if (options.now !== undefined && !supportInstant.safeParse(options.now).success)
    throw new CommunicationHistoryError('invalid_input')
  return [options.now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion]
}
async function actor(db: D1Database, claims: VerifiedSessionClaims, options: { now?: string }) {
  const result = await authorizeD1Session(db, claims, 'administration.manage', { ...options, requireMfa: true })
  if (!result.allowed) throw new CommunicationHistoryError(result.code)
}
async function checked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CommunicationHistoryError) throw error
    throw new CommunicationHistoryError('service_unavailable')
  }
}
type Ledger = {
  id: string
  actor_id: string
  event_id: string
  payload_hash: string
  input: string
  response: string
  created_at: string
}
async function proof(row: Ledger) {
  const receipt = communicationRetryReceiptSchema.parse(JSON.parse(row.response))
  const input = communicationRetryInputSchema.parse(JSON.parse(row.input))
  if (
    receipt.commandId !== row.id ||
    receipt.eventId !== row.event_id ||
    receipt.payloadHash !== row.payload_hash ||
    receipt.recordedAt !== row.created_at ||
    receipt.previousAvailableAt !== input.expectedAvailableAt ||
    receipt.attempts !== input.expectedAttempts ||
    (await communicationRetryIntentHash(row.event_id, input)) !== row.payload_hash
  )
    throw new CommunicationHistoryError('service_unavailable')
  return receipt
}
async function finalCommand(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: { now?: string }
) {
  const row = await db
    .prepare(
      `WITH authority AS MATERIALIZED(${authority})
 SELECT EXISTS(SELECT 1 FROM authority) AS authorized,
 (SELECT response FROM communication_history_commands WHERE id=?5 AND actor_id=?3 AND payload_hash=?6) AS response`
    )
    .bind(...binds(claims, options), key, hash)
    .first<{ authorized: number; response: string | null }>()
  if (!row?.authorized) throw new CommunicationHistoryError('unauthenticated')
  return row.response ? communicationRetryReceiptSchema.parse(JSON.parse(row.response)) : null
}
export async function readCommunicationHistory(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  rawQuery: unknown,
  options: { now?: string } = {}
): Promise<CommunicationHistory> {
  return checked(async () => {
    const query = communicationHistoryQuerySchema.safeParse(rawQuery)
    if (!query.success) throw new CommunicationHistoryError('invalid_input')
    const db = guardedFiscalDatabase(rawDb)
    await actor(db, claims, options)
    const { page, perPage, status, eventType, eventId } = query.data
    const row = await db
      .prepare(
        `WITH authority AS MATERIALIZED(${authority}), work AS MATERIALIZED(
 SELECT e.id AS eventId,e.event_type AS eventType,e.created_at AS createdAt,
 CASE WHEN EXISTS(SELECT 1 FROM operational_email_suppressions x WHERE x.event_id=e.id) THEN 'suppressed'
 ELSE COALESCE(d.status,'queued') END AS status,COALESCE(d.attempts,0) AS attempts,d.available_at AS availableAt,
 d.finished_at AS finishedAt,d.last_error_code AS errorCode,CASE WHEN ${retryable} THEN 1 ELSE 0 END AS canRetry
 FROM email_outbox_events e LEFT JOIN transactional_email_deliveries d ON d.event_id=e.id
 WHERE EXISTS(SELECT 1 FROM authority) AND ${visible}), filtered AS MATERIALIZED(
 SELECT * FROM work WHERE (?5 IS NULL OR status=?5) AND (?6 IS NULL OR eventType=?6) AND (?9 IS NULL OR eventId=?9)), selected AS(
 SELECT * FROM filtered ORDER BY createdAt DESC,eventId DESC LIMIT ?7 OFFSET ?8)
 SELECT EXISTS(SELECT 1 FROM authority) AS authorized,${clock} AS evaluatedAt,
 (SELECT count(*) FROM filtered) AS total,COALESCE((SELECT json_group_array(json_object(
 'eventId',eventId,'eventType',eventType,'createdAt',createdAt,'status',status,'attempts',attempts,
 'availableAt',availableAt,'finishedAt',finishedAt,'errorCode',errorCode,'canRetry',json(CASE WHEN canRetry=1 THEN 'true' ELSE 'false' END))) FROM selected),'[]') AS items`
      )
      .bind(
        ...binds(claims, options),
        status ?? null,
        eventType ?? null,
        perPage,
        (page - 1) * perPage,
        eventId ?? null
      )
      .first<{ authorized: number; evaluatedAt: string; total: number; items: string }>()
    if (!row?.authorized) throw new CommunicationHistoryError('unauthenticated')
    return communicationHistorySchema.parse({
      source: 'cloudflare',
      evaluatedAt: row.evaluatedAt,
      page,
      perPage,
      total: row.total,
      items: JSON.parse(row.items)
    })
  })
}
export async function retryCommunicationPreparation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  eventId: string,
  raw: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CommunicationRetryReceipt> {
  return checked(async () => {
    const input = communicationRetryInputSchema.safeParse(raw)
    if (
      !input.success ||
      !communicationEventIdSchema.safeParse(eventId).success ||
      !supportUuid.safeParse(options.idempotencyKey).success
    )
      throw new CommunicationHistoryError('invalid_input')
    const db = guardedFiscalDatabase(rawDb)
    await actor(db, claims, options)
    const hash = await communicationRetryIntentHash(eventId, input.data)
    const previous = await db
      .prepare('SELECT * FROM communication_history_commands WHERE id=?')
      .bind(options.idempotencyKey)
      .first<Ledger>()
    if (previous) {
      if (previous.actor_id !== claims.identityId || previous.event_id !== eventId || previous.payload_hash !== hash)
        throw new CommunicationHistoryError('idempotency_conflict')
      await proof(previous)
      const receipt = await finalCommand(db, claims, options.idempotencyKey, hash, options)
      if (!receipt) throw new CommunicationHistoryError('service_unavailable')
      return receipt
    }
    await db
      .prepare(
        `WITH authority AS MATERIALIZED(${authority})
 INSERT INTO communication_history_commands(id,actor_id,session_id,session_version,event_id,payload_hash,input,response,created_at)
 SELECT ?5,?3,?2,?4,e.id,?6,?7,json_object('source','cloudflare','commandId',?5,'eventId',e.id,'payloadHash',?6,
 'previousAvailableAt',d.available_at,'availableAt',${clock},'attempts',d.attempts,'recordedAt',${clock},
 'senderInvoked',json('false'),'attemptsReset',json('false'),'preparation','retry_requested'),${clock}
 FROM email_outbox_events e JOIN transactional_email_deliveries d ON d.event_id=e.id
 WHERE e.id=?8 AND EXISTS(SELECT 1 FROM authority) AND ${retryable}
 AND d.attempts=?9 AND d.available_at=?10 ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        ...binds(claims, options),
        options.idempotencyKey,
        hash,
        JSON.stringify(input.data),
        eventId,
        input.data.expectedAttempts,
        input.data.expectedAvailableAt
      )
      .run()
    const stored = await db
      .prepare('SELECT * FROM communication_history_commands WHERE id=?')
      .bind(options.idempotencyKey)
      .first<Ledger>()
    if (stored) {
      if (stored.actor_id !== claims.identityId || stored.event_id !== eventId || stored.payload_hash !== hash)
        throw new CommunicationHistoryError('idempotency_conflict')
      await proof(stored)
      const receipt = await finalCommand(db, claims, options.idempotencyKey, hash, options)
      if (!receipt) throw new CommunicationHistoryError('service_unavailable')
      return receipt
    }
    const failure = await db
      .prepare(
        `WITH authority AS MATERIALIZED(${authority}) SELECT
 EXISTS(SELECT 1 FROM authority) AS authorized,CASE WHEN ${retryable} THEN 1 ELSE 0 END AS retryable,
 d.attempts,d.available_at FROM email_outbox_events e JOIN transactional_email_deliveries d ON d.event_id=e.id
 WHERE e.id=?5`
      )
      .bind(...binds(claims, options), eventId)
      .first<{ authorized: number; retryable: number; attempts: number; available_at: string }>()
    if (!failure?.authorized) {
      await actor(db, claims, options)
      if (!failure) throw new CommunicationHistoryError('not_found')
      throw new CommunicationHistoryError('unauthenticated')
    }
    if (!failure.retryable) throw new CommunicationHistoryError('not_retryable')
    throw new CommunicationHistoryError('version_conflict')
  })
}
export async function readCommunicationRetryCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: { now?: string } = {}
): Promise<CommunicationRetryCommand> {
  return checked(async () => {
    if (!supportUuid.safeParse(key).success || !/^[a-f0-9]{64}$/.test(hash))
      throw new CommunicationHistoryError('invalid_input')
    const db = guardedFiscalDatabase(rawDb)
    await actor(db, claims, options)
    const row = await db
      .prepare('SELECT * FROM communication_history_commands WHERE id=? AND actor_id=? AND payload_hash=?')
      .bind(key, claims.identityId, hash)
      .first<Ledger>()
    if (row) await proof(row)
    const receipt = await finalCommand(db, claims, key, hash, options)
    return communicationRetryCommandSchema.parse(
      receipt
        ? { source: 'cloudflare', outcome: 'applied', receipt }
        : { source: 'cloudflare', outcome: 'unknown', receipt: null }
    )
  })
}
