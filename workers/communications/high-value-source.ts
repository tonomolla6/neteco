import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { readHighValueConsent } from './high-value-consent'
export class HighValueSourceError extends Error {
  constructor(readonly code: 'invalid_input' | 'event_unavailable' | 'unavailable') {
    super(code)
  }
}
export const highValueEventIdSchema = z
  .string()
  .refine((value) => z.string().uuid().safeParse(value).success || /^[a-f0-9]{32}$/.test(value))
const schema = z
  .object({ event: z.enum(['recall', 'delivery_exception', 'security_alert']), eventId: highValueEventIdSchema })
  .strict()
export async function assertHighValueEventSource(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  raw: unknown,
  options: { now?: () => string } = {}
) {
  const input = schema.safeParse(raw)
  if (!input.success) throw new HighValueSourceError('invalid_input')
  await readHighValueConsent(db, claims, customerId, 'sms', options)
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(now).success) throw new HighValueSourceError('unavailable')
  const row = await db
    .prepare(
      `SELECT CASE ?1
 WHEN 'security_alert' THEN EXISTS(SELECT 1 FROM identity_security_events e JOIN identities i ON i.id=e.identity_id WHERE e.id=?2 AND i.customer_id=?3 AND e.event_type IN('password_changed','session_revoked') AND e.created_at<=?4)
 WHEN 'delivery_exception' THEN EXISTS(SELECT 1 FROM order_fulfillment_commands c JOIN orders o ON o.id=c.order_id WHERE c.id=?2 AND c.action='exception' AND o.customer_id=?3 AND c.created_at<=?4)
 WHEN 'recall' THEN EXISTS(SELECT 1 FROM product_recall_commands c JOIN inventory_lot_allocations a ON a.lot_id=c.lot_id JOIN orders o ON o.id=a.order_id JOIN order_lines l ON l.order_id=a.order_id AND l.line_index=a.order_line_index JOIN inventory_lots lot ON lot.id=c.lot_id AND lot.variant_id=l.variant_id WHERE c.command_id=?2 AND c.action='open' AND c.created_at<=?4 AND o.customer_id=?3 AND (SELECT last.action FROM product_recall_commands last WHERE last.lot_id=c.lot_id ORDER BY last.version DESC LIMIT 1) IN('open','communicate','trace'))
 ELSE 0 END eligible`
    )
    .bind(input.data.event, input.data.eventId, customerId, now)
    .first<{ eligible: number }>()
  await readHighValueConsent(db, claims, customerId, 'sms', options)
  if (row?.eligible !== 1) throw new HighValueSourceError('event_unavailable')
  return { eligible: true as const }
}
