import { z } from 'zod'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { fiscalHash } from '../../shared/fiscal-issuance'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import type { TransactionalEmailSender } from './transactional-email-delivery'

export interface PreparedTransactionalEmail {
  message: Parameters<TransactionalEmailSender['send']>[0]
  rendererVersion: string
  sourceHash: string
  messageHash: string
  proof: Record<string, unknown>
}
export interface TransactionalEmailRenderer {
  /** Server-owned registration, never supplied by HTTP, Queue or event payload. */
  key: string
  version: string
  eventType:
    | 'identity.security.password_changed'
    | 'identity.security.password_rotated'
    | 'identity.security.email_changed'
    | 'identity.security.mfa_changed'
    | 'identity.security.fiscal_changed'
    | 'refund.succeeded.email'
    | 'invoice.issued'
    | 'support.ticket.received'
    | 'support.ticket.reply'
    | 'order.status.updated'
    | 'order.cancelled'
    | 'return.requested'
    | 'return.status.updated'
    | 'order.confirmed'
  sourceKind: 'refund' | 'invoice' | 'support' | 'order' | 'return' | 'identity'
  /** Trusted static SQL expression over email_outbox_events alias e. */
  sourcePredicate: string
  prepare(
    database: D1Database,
    eventId: string,
    from: string,
    context: {
      appEnvironment: 'local' | 'preview' | 'production'
      validationEnabled: boolean
    }
  ): Promise<PreparedTransactionalEmail | { error: 'invalid_source' | 'source_not_found' }>
  /** At least one atomic rollback guard for current source/recipient authority. */
  authorityStatements(
    database: D1Database,
    lease: {
      eventId: string
      leaseToken: string
      sendingAt: string
      leaseUntil: string
    },
    prepared: PreparedTransactionalEmail
  ): D1PreparedStatement[]
}
export interface TransactionalEmailDependencies {
  renderers?: readonly TransactionalEmailRenderer[]
}
const key = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/
export function registeredEmailRenderers(deps: TransactionalEmailDependencies, optIns: readonly string[] = []) {
  const registrations = deps.renderers ?? []
  if (!Array.isArray(registrations) || registrations.length > 20 || !Array.isArray(optIns) || optIns.length > 20)
    throw new Error('invalid_transactional_email_registry')
  const active: TransactionalEmailRenderer[] = [],
    seen = new Set<string>()
  const enabled = catalogPolicyOwnJson(optIns)
  if (
    !Array.isArray(enabled) ||
    enabled.some((value) => typeof value !== 'string' || !key.test(value)) ||
    new Set(enabled).size !== enabled.length
  )
    throw new Error('invalid_transactional_email_registry')
  for (let index = 0; index < registrations.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(registrations, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid_transactional_email_registry')
    const entry = descriptor.value as TransactionalEmailRenderer
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      throw new Error('invalid_transactional_email_registry')
    for (const field of [
      'key',
      'version',
      'eventType',
      'sourceKind',
      'sourcePredicate',
      'prepare',
      'authorityStatements'
    ]) {
      const member = Object.getOwnPropertyDescriptor(entry, field)
      if (!member || !Object.hasOwn(member, 'value')) throw new Error('invalid_transactional_email_registry')
    }
    if (
      typeof entry.key !== 'string' ||
      !key.test(entry.key) ||
      typeof entry.version !== 'string' ||
      !key.test(entry.version) ||
      seen.has(entry.key) ||
      typeof entry.prepare !== 'function' ||
      typeof entry.authorityStatements !== 'function' ||
      ![
        'identity.security.password_changed',
        'identity.security.password_rotated',
        'identity.security.email_changed',
        'identity.security.mfa_changed',
        'identity.security.fiscal_changed',
        'refund.succeeded.email',
        'invoice.issued',
        'support.ticket.received',
        'support.ticket.reply',
        'order.status.updated',
        'order.cancelled',
        'return.requested',
        'return.status.updated',
        'order.confirmed'
      ].includes(entry.eventType) ||
      !['refund', 'invoice', 'support', 'order', 'return', 'identity'].includes(entry.sourceKind) ||
      typeof entry.sourcePredicate !== 'string' ||
      entry.sourcePredicate.length < 1 ||
      entry.sourcePredicate.length > 4096 ||
      /;|--|\/\*/.test(entry.sourcePredicate)
    )
      throw new Error('invalid_transactional_email_registry')
    seen.add(entry.key)
    if (enabled.includes(entry.key))
      active.push(
        Object.freeze({
          key: entry.key,
          version: entry.version,
          eventType: entry.eventType,
          sourceKind: entry.sourceKind,
          sourcePredicate: entry.sourcePredicate,
          prepare: entry.prepare.bind(entry),
          authorityStatements: entry.authorityStatements.bind(entry)
        })
      )
  }
  if (enabled.some((value) => !seen.has(value))) throw new Error('invalid_transactional_email_registry')
  return active
}
const preparedSchema = z
  .object({
    message: z
      .object({
        to: z.string().email().max(254),
        from: z.string().email().max(254),
        subject: z.string().min(1).max(1024),
        text: z.string().min(1).max(524288),
        html: z.string().min(1).max(1048576)
      })
      .strict(),
    rendererVersion: z.string().regex(key),
    sourceHash: fiscalHash,
    messageHash: fiscalHash,
    proof: z.record(z.string(), z.unknown())
  })
  .strict()
export async function validatePreparedEmail(
  raw: unknown,
  renderer: TransactionalEmailRenderer,
  from: string
): Promise<PreparedTransactionalEmail> {
  const prepared = preparedSchema.parse(catalogPolicyOwnJson(raw))
  if (
    prepared.rendererVersion !== renderer.version ||
    prepared.message.from !== from ||
    /[\r\n]/.test(prepared.message.subject) ||
    (await sha256Hex(canonicalJson(prepared.message))) !== prepared.messageHash ||
    new TextEncoder().encode(prepared.message.html).byteLength > 1048576 ||
    new TextEncoder().encode(prepared.message.text).byteLength > 524288
  )
    throw new Error('invalid_transactional_email_preparation')
  return prepared
}
export function registeredEmailSendingStatements(
  database: D1Database,
  eventId: string,
  token: string,
  now: string,
  until: string,
  prepared: PreparedTransactionalEmail,
  renderer: TransactionalEmailRenderer
) {
  const bindings = [
    eventId,
    token,
    now,
    until,
    prepared.rendererVersion,
    prepared.sourceHash,
    prepared.messageHash,
    renderer.eventType,
    renderer.sourceKind
  ]
  const source = `EXISTS(SELECT 1 FROM email_outbox_events e WHERE e.id=?1 AND e.event_type=?8 AND e.source_kind=?9 AND e.schema_version=1 AND (${renderer.sourcePredicate}))`
  const lease = `event_id=?1 AND status='leased' AND lease_token=?2 AND lease_until>?3 AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  const manifest =
    'EXISTS(SELECT 1 FROM transactional_email_preparations WHERE event_id=?1 AND renderer_version=?5 AND source_hash=?6 AND message_hash=?7)'
  const authority = renderer.authorityStatements(
    database,
    { eventId, leaseToken: token, sendingAt: now, leaseUntil: until },
    prepared
  )
  if (
    !Array.isArray(authority) ||
    authority.length < 1 ||
    authority.length > 10 ||
    authority.some((statement) => !statement || typeof statement.bind !== 'function')
  )
    throw new Error('invalid_transactional_email_authority')
  return [
    database
      .prepare(
        `INSERT INTO transactional_email_preparations(event_id,renderer_version,source_hash,message_hash,prepared_at) SELECT ?1,?5,?6,?7,?3 WHERE EXISTS(SELECT 1 FROM transactional_email_deliveries WHERE ${lease}) AND ${source} AND NOT EXISTS(SELECT 1 FROM transactional_email_preparations WHERE event_id=?1)`
      )
      .bind(...bindings),
    database
      .prepare(
        `UPDATE transactional_email_deliveries SET status='sending',sending_at=?3,lease_until=?4,last_error_code=NULL WHERE ${lease} AND ${manifest} AND ${source} RETURNING event_id`
      )
      .bind(...bindings),
    ...authority,
    database
      .prepare(
        `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT(EXISTS(SELECT 1 FROM transactional_email_deliveries WHERE event_id=?1 AND status='sending' AND lease_token=?2 AND lease_until=?4) AND ${manifest} AND ${source})`
      )
      .bind(...bindings)
  ]
}
