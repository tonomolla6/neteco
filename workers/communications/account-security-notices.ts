import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { prepareEmailOutboxEnqueue } from './email-outbox'

const inputSchema = z
  .object({
    eventId: z.string().uuid(),
    identityId: z.string().uuid(),
    kind: z.enum(['password_changed', 'mfa_enabled', 'email_changed', 'fiscal_details_submitted']),
    recipient: z
      .string()
      .email()
      .max(254)
      .refine((value) => value === value.toLowerCase().trim() && !/\s/.test(value)),
    sessionVersion: z.number().int().positive(),
    now: catalogPolicyInstantSchema,
    audience: z.enum(['current', 'previous']).default('current'),
    domainEventId: z.string().uuid().optional()
  })
  .strict()
  .refine((value) => value.kind === 'email_changed' || value.audience === 'current')
  .refine((value) => value.kind === 'password_changed' || value.domainEventId !== undefined)

export const ACCOUNT_SECURITY_EMAIL_TYPES = {
  password_changed: 'identity.security.password_rotated',
  mfa_enabled: 'identity.security.mfa_changed',
  email_changed: 'identity.security.email_changed',
  fiscal_details_submitted: 'identity.security.fiscal_changed'
} as const

/** Server-only. Include ALL statements in the mutation's D1 batch. The old
 * email snapshot is inserted BEFORE rotation; the new one AFTER rotation. */
export async function prepareAccountSecurityNotice(
  database: D1Database,
  raw: z.input<typeof inputSchema>
): Promise<D1PreparedStatement[]> {
  const input = inputSchema.parse(raw)
  const values = [
    input.eventId,
    input.identityId,
    input.kind,
    input.recipient,
    input.audience,
    input.sessionVersion,
    input.domainEventId ?? null,
    input.now
  ]
  const { eventId } = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: input.eventId,
    sourceId: input.identityId,
    sourceKind: 'identity',
    eventType: ACCOUNT_SECURITY_EMAIL_TYPES[input.kind],
    now: input.now
  })
  const domain =
    input.kind === 'password_changed'
      ? `EXISTS(SELECT 1 FROM identity_security_events s WHERE s.identity_id=i.id AND s.event_type='password_changed' AND s.created_at=?8)`
      : input.kind === 'mfa_enabled'
        ? `EXISTS(SELECT 1 FROM mfa_enrollments e JOIN identity_mfa m ON m.identity_id=e.identity_id
          WHERE e.identity_id=i.id AND e.activation_id=?7 AND e.session_version=?6
          AND m.verified_at=?8 AND m.encrypted_secret=e.encrypted_secret)`
        : input.kind === 'email_changed'
          ? `EXISTS(SELECT 1 FROM identity_lifecycle_events l JOIN identity_lifecycle_tokens t ON t.id=l.token_id
            WHERE l.id=?7 AND l.identity_id=i.id AND l.event_type='email_changed' AND l.created_at=?8
            AND t.identity_id=i.id AND t.purpose='email_change' AND t.used_at=?8 AND t.revoked_at IS NULL
            AND t.created_at<=?8 AND t.expires_at>?8 AND (
              (?5='previous' AND t.session_version=?6 AND t.recipient<>?4)
              OR (?5='current' AND t.session_version+1=?6 AND t.recipient=?4)))`
          : `EXISTS(SELECT 1 FROM company_review_events e JOIN companies co ON co.id=e.company_id
            WHERE e.id=?7 AND e.actor_identity_id=i.id AND e.event_type='submitted' AND e.created_at=?8
            AND co.customer_id=i.customer_id AND co.last_change_id=e.id)`
  return [
    database
      .prepare(
        `INSERT INTO identity_account_security_events
      (id,identity_id,kind,recipient,audience,session_version,domain_event_id,created_at)
      SELECT ?1,i.id,?3,?4,?5,?6,?7,?8 FROM identities i JOIN customers c ON c.id=i.customer_id
      WHERE i.id=?2 AND i.email=?4 AND i.session_version=?6 AND i.status IN('pending','active') AND c.status='active'
      AND ${domain} ON CONFLICT(id) DO NOTHING`
      )
      .bind(...values),
    database
      .prepare(
        `INSERT INTO email_outbox_events
      (id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
      SELECT ?1,s.id,?2,'identity',s.identity_id,1,s.created_at FROM identity_account_security_events s
      WHERE s.id=?3 ON CONFLICT(source_event_id,event_type) DO NOTHING`
      )
      .bind(eventId, ACCOUNT_SECURITY_EMAIL_TYPES[input.kind], input.eventId),
    database
      .prepare(
        `INSERT INTO identity_account_security_guards(id,passed)
      SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM identity_account_security_events s
      JOIN email_outbox_events e ON e.source_event_id=s.id AND e.id=?9
      WHERE s.id=?1 AND s.identity_id=?2 AND s.kind=?3 AND s.recipient=?4 AND s.audience=?5
      AND s.session_version=?6 AND s.domain_event_id IS ?7 AND s.created_at=?8
      AND e.source_kind='identity' AND e.source_id=s.identity_id AND e.created_at=s.created_at)
      THEN 1 ELSE 0 END`
      )
      .bind(...values, eventId),
    database.prepare('DELETE FROM identity_account_security_guards WHERE id=?').bind(input.eventId)
  ]
}
