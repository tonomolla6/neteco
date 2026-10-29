import { z } from 'zod'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  DELIVERY_PREFERENCES_NOTICE_TEXT as TEXT,
  deliveryPreferenceIntentHash
} from '../../shared/delivery-preferences'
import { deliveryPreferenceProjectionProofSql } from '../auth/delivery-preferences'
import type { PreparedTransactionalEmail, TransactionalEmailRenderer } from './transactional-email-renderers'

/** Only operational fulfillment milestones are optional, never cancellation,
 * payment, tax, support, security, order receipts or marketing. */
export function isDeliveryNoticeRenderer(renderer: TransactionalEmailRenderer) {
  return (
    renderer.key === 'order.operations.fulfillment.v1' &&
    renderer.eventType === 'order.status.updated' &&
    renderer.sourceKind === 'order'
  )
}
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z
  .object({
    customerId: uuid.nullable(),
    version: z.number().int().nonnegative(),
    deliveryUpdates: z.union([z.literal(0), z.literal(1)]),
    commandId: uuid.nullable(),
    updatedAt: catalogPolicyInstantSchema.nullable(),
    expectedVersion: z.number().int().nonnegative().nullable(),
    payloadHash: hash.nullable(),
    textHash: hash.nullable(),
    policyVersion: z.literal(POLICY).nullable(),
    confirmed: z.literal(1)
  })
  .strict()
export type DeliveryNoticePreference = z.infer<typeof schema>
const joins = `FROM email_outbox_events e JOIN orders o ON o.id=e.source_id
 LEFT JOIN delivery_preferences p ON p.customer_id=o.customer_id
 LEFT JOIN delivery_preference_commands c ON c.customer_id=p.customer_id AND c.command_id=p.command_id`
const source = "e.id=?1 AND e.event_type='order.status.updated' AND e.source_kind='order' AND e.schema_version=1"
const proof = deliveryPreferenceProjectionProofSql('o.customer_id')

/** No active web session is needed to honor a durable customer choice. Missing
 * projection plus existing history is corruption, not a default opt-in. */
export async function readDeliveryNoticePreference(db: D1Database, eventId: string, now: string) {
  const value = schema.parse(
    await db
      .prepare(
        `SELECT o.customer_id customerId,COALESCE(p.version,0) version,
   COALESCE(p.delivery_updates,1) deliveryUpdates,p.command_id commandId,p.updated_at updatedAt,
   c.expected_version expectedVersion,c.payload_hash payloadHash,c.text_hash textHash,c.policy_version policyVersion,
   ${proof} confirmed ${joins} WHERE ${source} AND (p.updated_at IS NULL OR p.updated_at<=?2)`
      )
      .bind(eventId, now)
      .first()
  )
  if (value.version === 0) {
    if (
      !value.deliveryUpdates ||
      value.commandId !== null ||
      value.updatedAt !== null ||
      value.expectedVersion !== null ||
      value.payloadHash !== null ||
      value.textHash !== null ||
      value.policyVersion !== null
    )
      throw new Error('delivery_notice_preference_unconfirmed')
  } else {
    if (
      value.customerId === null ||
      value.commandId === null ||
      value.updatedAt === null ||
      value.expectedVersion !== value.version - 1 ||
      value.payloadHash !==
        (await deliveryPreferenceIntentHash({
          expectedVersion: value.expectedVersion,
          deliveryUpdates: value.deliveryUpdates === 1,
          policyVersion: POLICY
        })) ||
      value.textHash !==
        (await canonicalPayloadHash({
          policyVersion: POLICY,
          noticeText: TEXT,
          deliveryUpdates: value.deliveryUpdates === 1
        }))
    )
      throw new Error('delivery_notice_preference_unconfirmed')
  }
  return value
}
function bindings(eventId: string, token: string, now: string, preference: DeliveryNoticePreference) {
  return [
    eventId,
    token,
    now,
    preference.customerId,
    preference.version,
    preference.deliveryUpdates,
    preference.commandId,
    preference.updatedAt,
    preference.payloadHash,
    preference.textHash
  ]
}
const matching = `${source} AND ${proof} AND o.customer_id IS ?4 AND COALESCE(p.version,0)=?5
 AND COALESCE(p.delivery_updates,1)=?6 AND p.command_id IS ?7 AND p.updated_at IS ?8
 AND c.payload_hash IS ?9 AND c.text_hash IS ?10 AND (p.updated_at IS NULL OR p.updated_at<=?3)`
const lease =
  "d.event_id=?1 AND d.status='leased' AND d.lease_token=?2 AND d.lease_until>?3 AND d.lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now')"
export function deliveryNoticeSendingGuard(
  db: D1Database,
  eventId: string,
  token: string,
  now: string,
  preference: DeliveryNoticePreference
) {
  return db
    .prepare(
      `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(
   SELECT 1 ${joins} WHERE ${matching} AND ?6=1
   AND NOT EXISTS(SELECT 1 FROM operational_email_suppressions WHERE event_id=?1))`
    )
    .bind(...bindings(eventId, token, now, preference))
}
type Preparation = { prepared: PreparedTransactionalEmail; renderer: TransactionalEmailRenderer }
export async function suppressDeliveryNotice(
  db: D1Database,
  eventId: string,
  token: string,
  now: string,
  until: string,
  preparation: Preparation,
  preference: DeliveryNoticePreference
) {
  if (preference.deliveryUpdates !== 0) return false
  const args = bindings(eventId, token, now, preference)
  const results = await db.batch([
    ...preparation.renderer.authorityStatements(
      db,
      { eventId, leaseToken: token, sendingAt: now, leaseUntil: until },
      preparation.prepared
    ),
    db
      .prepare(
        `INSERT INTO operational_email_suppressions(event_id,customer_id,preference_command_id,preference_version,source_hash,suppressed_at,reason)
     SELECT e.id,o.customer_id,p.command_id,p.version,?11,?3,'delivery_updates_disabled' ${joins}
     WHERE ${matching} AND ?6=0 AND EXISTS(SELECT 1 FROM transactional_email_deliveries d WHERE ${lease})
     ON CONFLICT(event_id) DO NOTHING`
      )
      .bind(...args, preparation.prepared.sourceHash),
    db
      .prepare(
        `UPDATE transactional_email_deliveries SET status='pending',lease_token=NULL,lease_until=NULL
     WHERE event_id=?1 AND status='leased' AND lease_token=?2
     AND EXISTS(SELECT 1 FROM operational_email_suppressions WHERE event_id=?1) RETURNING event_id`
      )
      .bind(eventId, token)
  ])
  if (results.some((row) => row.success !== true)) throw new Error('delivery_notice_suppression_unconfirmed')
  return results.at(-1)?.results?.length === 1
}
/** A changed valid preference may invalidate a marker without invalidating its
 * source. Release only this still-owned pre-send lease, never a sending job. */
export async function retryChangedDeliveryNotice(
  db: D1Database,
  eventId: string,
  token: string,
  now: string,
  until: string,
  preparation: Preparation,
  preference: DeliveryNoticePreference
) {
  const results = await db.batch([
    ...preparation.renderer.authorityStatements(
      db,
      { eventId, leaseToken: token, sendingAt: now, leaseUntil: until },
      preparation.prepared
    ),
    deliveryNoticeSendingGuard(db, eventId, token, now, preference),
    db
      .prepare(
        `UPDATE transactional_email_deliveries SET status='pending',lease_token=NULL,lease_until=NULL
      WHERE event_id=?1 AND status='leased' AND lease_token=?2 RETURNING event_id`
      )
      .bind(eventId, token)
  ])
  if (results.some((row) => row.success !== true)) throw new Error('delivery_notice_retry_unconfirmed')
  return results.at(-1)?.results?.length === 1
}
