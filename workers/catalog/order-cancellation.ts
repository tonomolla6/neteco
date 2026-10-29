import { z } from 'zod'
import { prepareOrderOperationsEnqueue } from '../communications/order-operations-email'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { reservationReleaseStatements } from './inventory'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  orderCancellationAudienceSchema,
  orderCancellationInputSchema,
  orderCancellationReceiptSchema,
  orderCancellationEligibilitySchema,
  type OrderCancellationAudience,
  type OrderCancellationInput,
  type OrderCancellationReceipt,
  type OrderCancellationEligibility,
  type OrderCancellationCommand
} from '../../shared/order-cancellation'

export class OrderCancellationError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'not_eligible'
      | 'unavailable'
  ) {
    super(code)
  }
}
export interface OrderCancellationOptions {
  audience: OrderCancellationAudience
  now?: () => string
  /** Trusted ingress metadata only; never accepted from the request body. */
  ipHash?: string | null
}
const uuid = z.string().uuid()
const envelopeSchema = z
  .object({
    kind: z.literal('unpaid-order-cancellation'),
    actorId: uuid,
    input: orderCancellationInputSchema,
    receipt: orderCancellationReceiptSchema,
    auditContext: z
      .object({
        audience: orderCancellationAudienceSchema,
        sessionId: uuid,
        sessionVersion: z.number().int().positive(),
        ipHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable()
      })
      .strict()
      .optional()
  })
  .strict()
// The same authority predicate is read before work, checked inside the mutation
// transaction, and read atomically with ownership after the last asynchronous proof.
const authorityCte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS now),
 authority AS MATERIALIZED (
 SELECT i.id AS actorId,i.status AS identityStatus,s.mfa_verified AS mfaVerified,
 (i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) AS emailVerified,
 c.id AS customerId,o.id AS orderId,o.status AS orderStatus,o.reservation_id AS reservationId,
 o.updated_at AS orderUpdatedAt,r.status AS reservationStatus,r.idempotency_key AS reservationKey,
 r.expires_at AS reservationExpiresAt,state.status AS paymentStatus,
 EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
   WHERE assigned.identity_id=i.id AND granted.permission_code='administration.manage'
   AND assigned.granted_at<=(SELECT now FROM clock) AND (assigned.expires_at IS NULL OR assigned.expires_at>(SELECT now FROM clock))) AS permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 LEFT JOIN customers c ON c.id=i.customer_id AND c.status='active'
 LEFT JOIN orders o ON o.id=?5 AND (?6='admin' OR o.customer_id=c.id)
 LEFT JOIN inventory_reservations r ON r.id=o.reservation_id
 LEFT JOIN order_payment_states state ON state.order_id=o.id
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
 AND i.status IN ('active','pending') AND s.revoked_at IS NULL
 AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const authorityAllowed = `emailVerified=1 AND ((?6='admin' AND mfaVerified=1 AND permitted=1)
 OR (?6='customer' AND identityStatus='active' AND customerId IS NOT NULL)) AND orderId=?5`
const paymentHistory = `EXISTS(SELECT 1 FROM payment_intents WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM payment_events WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM payment_fulfilment_claims WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM payment_recovery_jobs WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM order_payment_states WHERE order_id=?5 AND
   (status<>'awaiting_payment' OR active_intent_id IS NOT NULL OR paid_gross_cents<>0))
 OR EXISTS(SELECT 1 FROM payment_commands WHERE order_id=?5
   AND COALESCE(json_extract(response_body,'$.kind'),'')<>'unpaid-order-cancellation')`
const preparationHistory = `EXISTS(SELECT 1 FROM order_fulfillments WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM order_fulfillment_commands WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM order_fulfillment_audit WHERE order_id=?5)`
const fiscalHistory = `EXISTS(SELECT 1 FROM fiscal_outbox_events WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM fiscal_invoice_intents WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM fiscal_documents WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM refund_contracts WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM fiscal_credit_contracts WHERE order_id=?5)`
const invalidReservation = `NOT EXISTS(SELECT 1 FROM order_lines WHERE order_id=?5)
 OR EXISTS(SELECT 1 FROM inventory_reservation_lines reserved WHERE reserved.reservation_id=reservationId
   AND reserved.quantity<>(SELECT COALESCE(sum(line.quantity),0) FROM order_lines line
     WHERE line.order_id=?5 AND line.variant_id=reserved.variant_id AND line.location_id=reserved.location_id))
 OR EXISTS(SELECT 1 FROM order_lines line WHERE line.order_id=?5 AND NOT EXISTS(
   SELECT 1 FROM inventory_reservation_lines reserved WHERE reserved.reservation_id=reservationId
     AND reserved.variant_id=line.variant_id AND reserved.location_id=line.location_id))
 OR (reservationStatus IN ('released','expired') AND EXISTS(
   SELECT 1 FROM inventory_reservation_lines reserved WHERE reserved.reservation_id=reservationId AND NOT EXISTS(
     SELECT 1 FROM inventory_movements movement WHERE movement.reference_type='reservation'
       AND movement.reference_id=reservationId AND movement.variant_id=reserved.variant_id AND movement.location_id=reserved.location_id
       AND movement.movement_type='release' AND movement.physical_delta=0 AND movement.reserved_delta=-reserved.quantity
       AND movement.idempotency_key=reservationKey||CASE WHEN reservationStatus='released' THEN ':release:' ELSE ':expiry:' END||reserved.variant_id||':'||reserved.location_id)))`
const blockerSql = `CASE WHEN orderStatus<>'awaiting_payment' THEN 'order_not_awaiting_payment'
 WHEN ${paymentHistory} THEN 'payment_history'
 WHEN ${preparationHistory} THEN 'preparation_history'
 WHEN ${fiscalHistory} THEN 'fiscal_history'
 WHEN reservationStatus IS NULL OR reservationStatus NOT IN ('reserved','released','expired') OR ${invalidReservation} THEN 'reservation_unavailable'
 ELSE NULL END`
const authoritySchema = z.object({
  actorId: uuid,
  identityStatus: z.enum(['pending', 'active']),
  mfaVerified: z.union([z.literal(0), z.literal(1)]),
  emailVerified: z.union([z.literal(0), z.literal(1)]),
  customerId: uuid.nullable(),
  orderId: uuid.nullable(),
  orderStatus: z.enum(['awaiting_payment', 'cancelled']).nullable(),
  orderUpdatedAt: catalogPolicyInstantSchema.nullable(),
  reservationId: z.string().min(1).max(200).nullable(),
  reservationKey: z.string().min(1).max(200).nullable(),
  reservationStatus: z.enum(['reserved', 'assigned', 'released', 'expired']).nullable(),
  reservationExpiresAt: catalogPolicyInstantSchema.nullable(),
  paymentStatus: z
    .enum(['awaiting_payment', 'processing', 'provider_authorised', 'paid', 'failed', 'cancelled', 'stock_exception'])
    .nullable(),
  permitted: z.union([z.literal(0), z.literal(1)])
})
function fail(code: OrderCancellationError['code']): never {
  throw new OrderCancellationError(code)
}
function parameters(
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: OrderCancellationOptions
): unknown[] {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  if (!uuid.safeParse(orderId).success) fail('not_found')
  if (!orderCancellationAudienceSchema.safeParse(options.audience).success) fail('invalid_input')
  const instant = options.now ? catalogPolicyInstantSchema.parse(options.now()) : null
  return [instant, claims.sessionId, claims.identityId, claims.sessionVersion, orderId, options.audience]
}
async function authority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: OrderCancellationOptions
) {
  const row = await database
    .prepare(`${authorityCte} SELECT * FROM authority`)
    .bind(...parameters(claims, orderId, options))
    .first()
  if (!row) fail('unauthenticated')
  const parsed = authoritySchema.safeParse(row)
  if (!parsed.success) fail('unavailable')
  const value = parsed.data
  if (!value.emailVerified) fail(options.audience === 'customer' ? 'unauthenticated' : 'email_unverified')
  if (options.audience === 'admin') {
    if (!value.mfaVerified) fail('mfa_required')
    if (!value.permitted) fail('forbidden')
  } else if (value.identityStatus !== 'active' || !value.customerId) fail('unauthenticated')
  if (value.orderId !== orderId) fail('not_found')
  return value
}
async function eligibility(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: OrderCancellationOptions
) {
  await authority(database, claims, orderId, options)
  const row = await database
    .prepare(
      `${authorityCte} SELECT 'cloudflare' AS source,orderId,
    (${blockerSql}) IS NULL AS eligible,${blockerSql} AS blocker,orderStatus,paymentStatus,reservationStatus
    FROM authority WHERE ${authorityAllowed}`
    )
    .bind(...parameters(claims, orderId, options))
    .first<Record<string, unknown>>()
  if (!row) {
    await authority(database, claims, orderId, options)
    fail('unavailable')
  }
  const parsed = orderCancellationEligibilitySchema.safeParse({ ...row, eligible: row.eligible === 1 })
  if (!parsed.success || ![0, 1].includes(Number(row.eligible))) fail('unavailable')
  return parsed.data
}
export async function readD1OrderCancellation(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: OrderCancellationOptions
): Promise<OrderCancellationEligibility> {
  const result = await eligibility(database, claims, orderId, options)
  await authority(database, claims, orderId, options)
  return result
}
async function receipt(database: D1Database, orderId: string, commandId: string, expectedHash?: string) {
  if (!uuid.safeParse(commandId).success) fail('invalid_input')
  const row = await database
    .prepare(
      `SELECT c.payload_hash AS payloadHash,c.response_status AS responseStatus,
    c.response_body AS responseBody,c.correlation_id AS correlationId,c.created_at AS createdAt,e.payload_json AS audit,
    e.created_at AS auditAt,e.correlation_id AS auditCorrelation
    FROM payment_commands c LEFT JOIN order_events e ON e.id='order-cancelled:'||c.order_id||':'||c.command_id
      AND e.order_id=c.order_id AND e.event_type='order.cancelled'
    WHERE c.order_id=?1 AND c.command_id=?2`
    )
    .bind(orderId, commandId)
    .first<Record<string, unknown>>()
  if (!row) return null
  if (expectedHash !== undefined && row.payloadHash !== expectedHash) fail('conflict')
  return validateOrderCancellationProof(row, orderId, commandId)
}
/** Pure receipt/audit verification, shared by recovery and the bounded timeline projection. */
export async function validateOrderCancellationProof(row: Record<string, unknown>, orderId: string, commandId: string) {
  try {
    const envelope = envelopeSchema.parse(JSON.parse(String(row.responseBody)))
    const audit = z
      .object({ commandId: uuid, payloadHash: z.string().regex(/^[0-9a-f]{64}$/), ...envelopeSchema.shape })
      .strict()
      .parse(JSON.parse(String(row.audit)))
    const payloadHash = await canonicalPayloadHash({
      kind: envelope.kind,
      orderId,
      actorId: envelope.actorId,
      ...envelope.input
    })
    if (
      row.responseStatus !== 200 ||
      envelope.receipt.orderId !== orderId ||
      envelope.receipt.commandId !== commandId ||
      row.createdAt !== envelope.receipt.updatedAt ||
      row.auditAt !== row.createdAt ||
      row.correlationId !== commandId ||
      row.auditCorrelation !== commandId ||
      row.payloadHash !== payloadHash ||
      audit.commandId !== commandId ||
      audit.payloadHash !== payloadHash ||
      JSON.stringify(envelope) !==
        JSON.stringify({
          kind: audit.kind,
          actorId: audit.actorId,
          input: audit.input,
          receipt: audit.receipt,
          ...(audit.auditContext ? { auditContext: audit.auditContext } : {})
        })
    )
      fail('unavailable')
    return { envelope, payloadHash }
  } catch {
    fail('unavailable')
  }
}
export async function readD1OrderCancellationCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  commandId: string,
  options: OrderCancellationOptions
): Promise<OrderCancellationCommand> {
  await authority(database, claims, orderId, options)
  const stored = await receipt(database, orderId, commandId)
  const final = await authority(database, claims, orderId, options)
  if (!stored) return { source: 'cloudflare', orderId, commandId, outcome: 'unknown' }
  if (final.orderStatus !== 'cancelled' || !['released', 'expired'].includes(final.reservationStatus ?? ''))
    fail('unavailable')
  return stored.envelope.receipt
}
export async function cancelD1UnpaidOrder(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  commandId: string,
  input: OrderCancellationInput,
  options: OrderCancellationOptions
): Promise<OrderCancellationReceipt> {
  const parsed = orderCancellationInputSchema.safeParse(input)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  const initial = await authority(database, claims, orderId, options)
  const payloadHash = await canonicalPayloadHash({
    kind: 'unpaid-order-cancellation',
    orderId,
    actorId: initial.actorId,
    ...parsed.data
  })
  const previous = await receipt(database, orderId, commandId, payloadHash)
  if (previous) {
    if (previous.payloadHash !== payloadHash) fail('conflict')
    return (await readD1OrderCancellationCommand(
      database,
      claims,
      orderId,
      commandId,
      options
    )) as OrderCancellationReceipt
  }
  const eligible = await eligibility(database, claims, orderId, options)
  if (!eligible.eligible) fail('not_eligible')
  const live = await authority(database, claims, orderId, options)
  if (!live.reservationId || !live.reservationKey || !live.reservationStatus) fail('unavailable')
  const clock = await database
    .prepare("SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS now")
    .bind(options.now?.() ?? null)
    .first<{ now: string }>()
  if (!clock || !catalogPolicyInstantSchema.safeParse(clock.now).success) fail('unavailable')
  const result = orderCancellationReceiptSchema.parse({
    source: 'cloudflare',
    orderId,
    commandId,
    outcome: 'cancelled',
    orderStatus: 'cancelled',
    inventoryEffect:
      live.reservationStatus === 'reserved'
        ? 'released'
        : live.reservationStatus === 'released'
          ? 'already_released'
          : 'expired',
    updatedAt: clock.now
  })
  const envelope = envelopeSchema.parse({
    kind: 'unpaid-order-cancellation' as const,
    actorId: live.actorId,
    input: parsed.data,
    receipt: result,
    auditContext: {
      audience: options.audience,
      sessionId: claims!.sessionId,
      sessionVersion: claims!.sessionVersion,
      ipHash: options.ipHash ?? null
    }
  })
  const guard = (condition: string) =>
    database
      .prepare(
        `${authorityCte} SELECT CASE WHEN ${condition} THEN 1 ELSE json('cancellation atomic guard failed') END AS satisfied`
      )
      .bind(...parameters(claims, orderId, options), live.reservationStatus, live.reservationId, live.reservationKey)
  const batch = [
    guard(`EXISTS(SELECT 1 FROM authority WHERE ${authorityAllowed} AND orderStatus='awaiting_payment'
      AND reservationStatus=?7 AND reservationId=?8 AND reservationKey=?9 AND NOT (${invalidReservation}))
      AND NOT (${paymentHistory}) AND NOT (${preparationHistory}) AND NOT (${fiscalHistory})`),
    ...(live.reservationStatus === 'reserved'
      ? reservationReleaseStatements(database, {
          idempotencyKey: live.reservationKey,
          correlationId: commandId,
          reason: parsed.data.reason,
          now: clock.now
        })
      : []),
    database
      .prepare("UPDATE orders SET status='cancelled',updated_at=?2 WHERE id=?1 AND status='awaiting_payment'")
      .bind(orderId, clock.now),
    database
      .prepare(
        `INSERT INTO payment_commands(order_id,command_id,payload_hash,response_status,response_body,correlation_id,created_at)
      VALUES(?1,?2,?3,200,?4,?2,?5)`
      )
      .bind(orderId, commandId, payloadHash, JSON.stringify(envelope), clock.now),
    database
      .prepare(
        `INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at)
      VALUES('order-cancelled:'||?1||':'||?2,?1,'order.cancelled',?3,?2,?4)`
      )
      .bind(orderId, commandId, JSON.stringify({ commandId, payloadHash, ...envelope }), clock.now),
    guard(`EXISTS(SELECT 1 FROM authority WHERE ${authorityAllowed} AND orderStatus='cancelled'
      AND reservationStatus IN ('released','expired') AND reservationId=?8 AND reservationKey=?9 AND ?7 IN ('reserved','released','expired'))
      AND NOT (${paymentHistory}) AND NOT (${preparationHistory}) AND NOT (${fiscalHistory})`)
  ]
  batch.push(await prepareOrderOperationsEnqueue(database, { orderId, commandId, kind: 'cancelled', now: clock.now }))
  try {
    await database.batch(batch)
  } catch {
    await authority(database, claims, orderId, options)
    // A timeout may follow a successful commit. Do not turn it into "not applied"
    // or retry a write: the explicit read-only command endpoint resolves it.
    if (await receipt(database, orderId, commandId)) fail('unavailable')
    const after = await eligibility(database, claims, orderId, options)
    if (!after.eligible) fail('not_eligible')
    fail('unavailable')
  }
  const stored = await readD1OrderCancellationCommand(database, claims, orderId, commandId, options)
  if (stored.outcome !== 'cancelled') fail('unavailable')
  return stored
}
