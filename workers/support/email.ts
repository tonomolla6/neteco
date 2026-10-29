import { z } from 'zod'
import { supportRef, supportUuid } from '../../shared/support-operations'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import type {
  PreparedTransactionalEmail,
  TransactionalEmailRenderer
} from '../communications/transactional-email-delivery'

const VERSION = 'support-public-v1'
// Static, server-owned predicate; note/call/customer replies can never render.
const predicate =
  'EXISTS(SELECT 1 FROM support_commands c JOIN support_events s ON s.id=c.id ' +
  'JOIN support_tickets t ON t.id=c.ticket_id WHERE c.id=e.source_event_id AND t.id=e.source_id ' +
  "AND s.ticket_id=t.id AND s.visibility='public' AND s.type=c.action " +
  "AND ((e.event_type='support.ticket.received' AND c.action='created') OR " +
  "(e.event_type='support.ticket.reply' AND c.action='reply' AND c.actor_type='admin')) " +
  "AND s.body IS json_extract(c.input,'$.message'))"
type Source = {
  eventId: string
  eventType: string
  commandId: string
  ticketId: string
  publicRef: string
  customerId: string | null
  creationActor: string | null
  recipient: string
  requester: string
  body: string
  retentionUntil: string | null
  policy: string | null
  resultVersion: number
}
const mailbox = z
  .string()
  .email()
  .max(254)
  .refine((value) => !/[\s\r\n]/.test(value))
function escape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
async function source(database: D1Database, eventId: string): Promise<Source | null> {
  return database
    .prepare(
      'SELECT e.id AS eventId,e.event_type AS eventType,c.id AS commandId,t.id AS ticketId,' +
        't.public_ref AS publicRef,t.customer_id AS customerId,first.actor_id AS creationActor,' +
        "CASE WHEN t.customer_id IS NULL THEN json_extract(t.requester,'$.email') ELSE i.email END AS recipient," +
        't.requester,s.body,t.retention_until AS retentionUntil,t.policy,c.result_version AS resultVersion ' +
        'FROM email_outbox_events e JOIN support_commands c ON c.id=e.source_event_id ' +
        'JOIN support_events s ON s.id=c.id JOIN support_tickets t ON t.id=e.source_id ' +
        "JOIN support_commands first ON first.ticket_id=t.id AND first.action='created' " +
        "LEFT JOIN identities i ON i.id=first.actor_id AND i.customer_id=t.customer_id AND i.status='active' " +
        "AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') " +
        "LEFT JOIN customers customer ON customer.id=t.customer_id AND customer.status='active' " +
        "WHERE e.id=?1 AND e.schema_version=1 AND e.source_kind='support' AND (" +
        predicate +
        ') ' +
        'AND (t.customer_id IS NULL OR (i.id IS NOT NULL AND customer.id IS NOT NULL)) ' +
        "AND (t.retention_until IS NULL OR t.retention_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
    )
    .bind(eventId)
    .first<Source>()
}
export async function prepareSupportEmail(
  rawDatabase: D1Database,
  eventId: string,
  from: string,
  _context: { appEnvironment: 'local' | 'preview' | 'production'; validationEnabled: boolean }
): Promise<PreparedTransactionalEmail | { error: 'invalid_source' | 'source_not_found' }> {
  const database = guardedFiscalDatabase(rawDatabase),
    row = await source(database, eventId)
  if (!row) return { error: 'source_not_found' }
  if (
    !mailbox.safeParse(from).success ||
    !mailbox.safeParse(row.recipient).success ||
    !supportRef.safeParse(row.publicRef).success ||
    !supportUuid.safeParse(row.commandId).success ||
    !supportUuid.safeParse(row.ticketId).success ||
    typeof row.body !== 'string' ||
    row.body.length > 5000
  )
    return { error: 'invalid_source' }
  const received = row.eventType === 'support.ticket.received'
  // Verified cases use the current verified identity mailbox, never a form
  // email as proof of order ownership. Notification carries no order/PII facts.
  const text = received
    ? 'Hemos registrado tu consulta ' + row.publicRef + '.'
    : row.customerId
      ? 'Hay una nueva respuesta en tu consulta ' + row.publicRef + '. Consulta tu portal de soporte verificado.'
      : 'Respuesta a tu consulta ' + row.publicRef + ':\n\n' + row.body
  const footer =
    '\n\nEl número de consulta no acredita la identidad ni permite acceder a pedidos. Esta consulta no realiza ni acredita reembolsos, cambios fiscales ni movimientos de inventario.'
  const message = {
    to: row.recipient,
    from,
    subject: received ? 'Consulta recibida ' + row.publicRef : 'Respuesta de soporte ' + row.publicRef,
    text: text + footer,
    html: '<p>' + escape(text).replaceAll('\n', '<br>') + '</p><p>' + escape(footer.trim()) + '</p>'
  }
  return {
    message,
    rendererVersion: VERSION,
    sourceHash: await sha256Hex(canonicalJson(row)),
    messageHash: await sha256Hex(canonicalJson(message)),
    proof: { ...row }
  }
}
function authorityStatements(
  database: D1Database,
  lease: { eventId: string; leaseToken: string; sendingAt: string; leaseUntil: string },
  prepared: PreparedTransactionalEmail
) {
  const p = prepared.proof
  if (
    p.eventId !== lease.eventId ||
    typeof p.recipient !== 'string' ||
    typeof p.commandId !== 'string' ||
    typeof p.ticketId !== 'string' ||
    typeof p.requester !== 'string' ||
    typeof p.body !== 'string'
  )
    throw new Error('invalid_support_email_proof')
  const valid =
    'EXISTS(SELECT 1 FROM email_outbox_events e JOIN support_commands c ON c.id=e.source_event_id ' +
    'JOIN support_events s ON s.id=c.id JOIN support_tickets t ON t.id=e.source_id ' +
    "JOIN support_commands first ON first.ticket_id=t.id AND first.action='created' " +
    'LEFT JOIN identities i ON i.id=first.actor_id LEFT JOIN customers customer ON customer.id=t.customer_id ' +
    'WHERE e.id=?1 AND c.id=?2 AND t.id=?3 AND t.public_ref=?4 AND t.requester=?5 AND s.body=?6 ' +
    'AND t.customer_id IS ?7 AND first.actor_id IS ?8 AND c.result_version=?9 ' +
    'AND t.retention_until IS ?10 AND t.policy IS ?11 AND (' +
    predicate +
    ') ' +
    "AND (t.retention_until IS NULL OR (t.retention_until>?13 AND t.retention_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))) " +
    "AND ((t.customer_id IS NULL AND json_extract(t.requester,'$.email')=?12) OR " +
    "(i.customer_id=t.customer_id AND i.status='active' AND i.email=?12 AND i.email_verified_at IS NOT NULL " +
    "AND i.email_verified_at<=?13 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND customer.status='active')))"
  return [
    database
      .prepare('INSERT INTO support_guards(id,satisfied) SELECT ?14,0 WHERE NOT(' + valid + ')')
      .bind(
        lease.eventId,
        p.commandId,
        p.ticketId,
        p.publicRef,
        p.requester,
        p.body,
        p.customerId,
        p.creationActor,
        p.resultVersion,
        p.retentionUntil,
        p.policy,
        p.recipient,
        lease.sendingAt,
        crypto.randomUUID()
      )
  ]
}
export const supportEmailRenderers: readonly TransactionalEmailRenderer[] = [
  {
    key: 'support.ticket.received.v1',
    version: VERSION,
    eventType: 'support.ticket.received',
    sourceKind: 'support',
    sourcePredicate: predicate,
    prepare: prepareSupportEmail,
    authorityStatements
  },
  {
    key: 'support.ticket.reply.v1',
    version: VERSION,
    eventType: 'support.ticket.reply',
    sourceKind: 'support',
    sourcePredicate: predicate,
    prepare: prepareSupportEmail,
    authorityStatements
  }
]
