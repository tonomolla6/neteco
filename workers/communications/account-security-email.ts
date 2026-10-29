import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { ACCOUNT_SECURITY_EMAIL_TYPES } from './account-security-notices'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailRenderer } from './transactional-email-renderers'

const rowSchema = z
  .object({
    id: z.string().uuid(),
    identity_id: z.string().uuid(),
    kind: z.enum(['password_changed', 'mfa_enabled', 'email_changed', 'fiscal_details_submitted']),
    recipient: z
      .string()
      .email()
      .max(254)
      .refine((value) => !/\s/.test(value)),
    audience: z.enum(['current', 'previous']),
    session_version: z.number().int().positive(),
    domain_event_id: z.string().uuid().nullable(),
    created_at: catalogPolicyInstantSchema
  })
  .strict()
// The immutable event is the historical recipient authority. Only an email
// change can address its previous mailbox; no future profile can retarget it.
const sourceSql = `SELECT s.id,s.identity_id,s.kind,s.recipient,s.audience,s.session_version,s.domain_event_id,s.created_at
 FROM email_outbox_events e JOIN identity_account_security_events s ON s.id=e.source_event_id AND s.identity_id=e.source_id
 JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE e.id=?1 AND s.kind=?2 AND e.source_kind='identity' AND e.schema_version=1 AND e.created_at=s.created_at
 AND e.event_type=CASE s.kind WHEN 'password_changed' THEN 'identity.security.password_rotated'
 WHEN 'mfa_enabled' THEN 'identity.security.mfa_changed' WHEN 'email_changed' THEN 'identity.security.email_changed'
 WHEN 'fiscal_details_submitted' THEN 'identity.security.fiscal_changed' END
 AND i.status IN('pending','active') AND c.status='active' AND i.session_version>=s.session_version
 AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND (s.kind='email_changed' OR (s.audience='current' AND i.email=s.recipient))
 AND CASE s.kind
 WHEN 'password_changed' THEN EXISTS(SELECT 1 FROM identity_security_events a WHERE a.identity_id=s.identity_id AND a.event_type='password_changed' AND a.created_at=s.created_at)
 WHEN 'mfa_enabled' THEN EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=s.identity_id AND m.verified_at=s.created_at)
 WHEN 'email_changed' THEN EXISTS(SELECT 1 FROM identity_lifecycle_events l JOIN identity_lifecycle_tokens t ON t.id=l.token_id
  WHERE l.id=s.domain_event_id AND l.identity_id=s.identity_id AND l.event_type='email_changed' AND l.created_at=s.created_at
  AND t.identity_id=s.identity_id AND t.purpose='email_change' AND t.used_at=s.created_at AND t.revoked_at IS NULL
  AND t.created_at<=s.created_at AND t.expires_at>s.created_at AND i.session_version>=t.session_version+1
  AND ((s.audience='previous' AND t.session_version=s.session_version AND t.recipient<>s.recipient)
   OR(s.audience='current' AND t.session_version+1=s.session_version AND t.recipient=s.recipient)))
 WHEN 'fiscal_details_submitted' THEN EXISTS(SELECT 1 FROM company_review_events a JOIN companies co ON co.id=a.company_id
  WHERE a.id=s.domain_event_id AND a.actor_identity_id=s.identity_id AND a.event_type='submitted' AND a.created_at=s.created_at AND co.customer_id=i.customer_id)
 ELSE 0 END`
const descriptions = {
  password_changed: ['Tu contraseña se ha cambiado', 'Se ha cambiado la contraseña de tu cuenta NETECO.'],
  mfa_enabled: [
    'Se ha activado la verificación en dos pasos',
    'Se ha activado la verificación en dos pasos de tu cuenta NETECO.'
  ],
  email_changed: [
    'Se ha cambiado el correo de tu cuenta',
    'Se ha completado un cambio verificado del correo de tu cuenta NETECO.'
  ],
  fiscal_details_submitted: [
    'Se han presentado cambios fiscales',
    'Se han presentado datos fiscales de tu cuenta NETECO para revisión. Este aviso no significa que se hayan aprobado.'
  ]
} as const

export const accountSecurityEmailRenderers: readonly TransactionalEmailRenderer[] = Object.entries(
  ACCOUNT_SECURITY_EMAIL_TYPES
).map(([kind, eventType]) => {
  const version = `account-security-notice-v1:${kind}`
  return {
    key: version,
    version,
    eventType,
    sourceKind: 'identity',
    // No late-schema references in global selection: historical unrelated mail
    // fixtures/streams never read security tables. Event types are disjoint.
    sourcePredicate: "e.source_kind='identity'",
    async prepare(database, eventId, from) {
      const raw = await database.prepare(sourceSql).bind(eventId, kind).first()
      const parsed = rowSchema.safeParse(raw)
      if (!parsed.success) return { error: 'invalid_source' as const }
      const row = parsed.data
      const [title, description] = descriptions[row.kind]
      const text = `${description} Si no has sido tú, contacta con NETECO y revisa la seguridad de tu cuenta.\nRegistro: ${row.created_at}`
      const message = {
        to: row.recipient,
        from,
        subject: `NETECO: ${title}`,
        text: `${title}\n\n${text}`,
        html: `<!doctype html><html lang="es"><body><h1>${escapeEmailHtml(title)}</h1><p>${escapeEmailHtml(text)}</p></body></html>`
      }
      return {
        message,
        rendererVersion: version,
        sourceHash: await sha256Hex(canonicalJson(row)),
        messageHash: await sha256Hex(canonicalJson(message)),
        proof: { row }
      }
    },
    authorityStatements(database, lease, prepared) {
      const row = rowSchema.parse(prepared.proof.row),
        fields = Object.keys(row) as (keyof typeof row)[]
      return [
        database
          .prepare(
            `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(
        SELECT 1 FROM (${sourceSql}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 3}`).join(' AND ')})`
          )
          .bind(lease.eventId, kind, ...fields.map((field) => row[field]))
      ]
    }
  }
})
