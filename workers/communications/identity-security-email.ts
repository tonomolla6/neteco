import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from './email-outbox'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailRenderer } from './transactional-email-renderers'

// Only a completed password-reset operation, not a reset request, authorizes
// this notice. Tokens are a persisted contract, NOT an immutable table: compare
// the recipient with the live identity and recheck every field at the marker.
const sourceSql = `SELECT l.id operation_id,l.identity_id,l.token_id,l.created_at,
 t.recipient,t.session_version reset_version,t.used_at,i.email identity_email,i.session_version identity_version
 FROM email_outbox_events e JOIN identity_lifecycle_events l ON l.id=e.source_event_id AND l.identity_id=e.source_id
 JOIN identity_lifecycle_tokens t ON t.id=l.token_id AND t.identity_id=l.identity_id
 JOIN identities i ON i.id=l.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE e.id=?1 AND e.event_type='identity.security.password_changed' AND e.source_kind='identity' AND e.schema_version=1
 AND l.event_type='password_reset' AND e.created_at=l.created_at AND t.purpose='password_reset'
 AND t.used_at=l.created_at AND t.revoked_at IS NULL AND t.created_at<=l.created_at AND t.expires_at>l.created_at
 AND l.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND i.session_version>=t.session_version+1 AND i.email=t.recipient AND i.status IN('pending','active') AND c.status='active'
 AND EXISTS(SELECT 1 FROM identity_security_events s WHERE s.identity_id=l.identity_id AND s.event_type='password_changed' AND s.created_at=l.created_at)`
const rowSchema = z
  .object({
    operation_id: z.string().uuid(),
    identity_id: z.string().uuid(),
    token_id: z.string().uuid(),
    created_at: catalogPolicyInstantSchema,
    recipient: z
      .string()
      .email()
      .max(254)
      .refine((value) => !/\s/.test(value)),
    reset_version: z.number().int().positive(),
    used_at: catalogPolicyInstantSchema,
    identity_email: z.string().email().max(254),
    identity_version: z.number().int().positive()
  })
  .strict()
const hash = (value: unknown) => sha256Hex(canonicalJson(value))
const version = 'identity-password-reset-notice-v1'
export const passwordResetSecurityEmailRenderer: TransactionalEmailRenderer = {
  key: version,
  version,
  eventType: 'identity.security.password_changed',
  sourceKind: 'identity',
  // Selection is only transport classification; prepare/final guard below own
  // full lifecycle proof. No identity-table reads for unrelated email streams.
  sourcePredicate: "e.source_kind='identity'",
  async prepare(database, eventId, from) {
    // Infrastructure failures must propagate to the dispatcher's bounded
    // pre-provider retry path, not become a terminal invalid-source verdict.
    const raw = await database.prepare(sourceSql).bind(eventId).first()
    const parsed = rowSchema.safeParse(raw)
    if (!parsed.success) return { error: 'invalid_source' }
    const row = parsed.data
    const title = 'Tu contraseña se ha restablecido'
    const explanation =
      'Se ha completado un restablecimiento de la contraseña de tu cuenta NETECO. Si no has sido tú, contacta con NETECO y revisa la seguridad de tu cuenta.'
    const message = {
      to: row.recipient,
      from,
      subject: `NETECO: ${title}`,
      text: `${title}\n\n${explanation}\nRegistro: ${row.created_at}`,
      html: `<!doctype html><html lang="es"><body><h1>${escapeEmailHtml(title)}</h1><p>${escapeEmailHtml(explanation)}</p><p>Registro: ${escapeEmailHtml(row.created_at)}</p></body></html>`
    }
    return {
      message,
      rendererVersion: version,
      sourceHash: await hash(row),
      messageHash: await hash(message),
      proof: { row }
    }
  },
  authorityStatements(database, lease, prepared) {
    const row = rowSchema.parse(prepared.proof.row),
      fields = Object.keys(row) as (keyof typeof row)[]
    return [
      database
        .prepare(
          `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(SELECT 1 FROM (${sourceSql}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 2}`).join(' AND ')})`
        )
        .bind(lease.eventId, ...fields.map((field) => row[field]))
    ]
  }
}

/** Append to the same batch as the successful reset/event, never after commit. */
export async function preparePasswordResetSecurityNotice(
  database: D1Database,
  input: { operationId: string; identityId: string; now: string }
) {
  return (
    await prepareEmailOutboxEnqueue(database, {
      sourceEventId: input.operationId,
      sourceId: input.identityId,
      sourceKind: 'identity',
      eventType: 'identity.security.password_changed',
      now: input.now
    })
  ).statement
}
