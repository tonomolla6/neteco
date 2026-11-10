import { z } from 'zod'
import { prepareOrderOperationsEnqueue } from '../communications/order-operations-email'
import {
  adminOrderFulfillmentSchema,
  allowedFulfillmentActions,
  fulfillmentCommandReceiptSchema,
  fulfillmentIdempotencyKeySchema,
  fulfillmentOrderIdSchema,
  fulfillmentStateSchema,
  fulfillmentTransitionInputSchema,
  type AdminOrderFulfillment,
  type FulfillmentBlocker,
  type FulfillmentCommandReceipt,
  type FulfillmentTransitionInput
} from '../../shared/order-fulfillment'
import {
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { readOrderPurchaseOrderReference } from '../catalog/order-customer-reference'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { AdminInvitationError, authorizeD1AdminInvitationActor } from '../auth/admin-invitations'
import { orderStoreCreditSql } from '../pricing/order-store-credit-sql'

export type FulfillmentErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'shipping_mode_mismatch'
  | 'order_cancelled'
  | 'payment_unconfirmed'
  | 'inventory_unconfirmed'
  | 'warehouse_unavailable'
  | 'shipping_mode_unavailable'
  | 'history_unconfirmed'
  | 'conflict'
export class FulfillmentError extends Error {
  constructor(readonly code: FulfillmentErrorCode) {
    super(code)
    this.name = 'FulfillmentError'
  }
}
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  positive = safe.min(1)
const claimsSchema = z
  .object({ identityId: catalogPolicyUuidSchema, sessionId: catalogPolicyUuidSchema, sessionVersion: positive })
  .strict()
function checked<T, I>(schema: z.ZodType<T, I>, raw: unknown, code: FulfillmentErrorCode = 'invalid_input'): T {
  let data: unknown
  try {
    data = catalogPolicyOwnJson(raw)
  } catch {
    throw new FulfillmentError(code)
  }
  const result = schema.safeParse(data)
  if (!result.success) throw new FulfillmentError(code)
  return result.data
}
function instant(now?: string) {
  return now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function freshClock(now?: string) {
  const started = Date.now()
  return () =>
    now === undefined
      ? undefined
      : new Date(Date.parse(now) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string, requireEnrolledMfa?: true) {
  if (requireEnrolledMfa) {
    try {
      await authorizeD1AdminInvitationActor(database, claims, true, now === undefined ? {} : { now })
      return
    } catch (error) {
      if (
        error instanceof AdminInvitationError &&
        ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].some((code) => code === error.code)
      )
        throw new FulfillmentError(error.code as 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden')
      throw error
    }
  }
  const auth = await authorizeD1Session(database, claims, 'administration.manage', {
    requireMfa: true,
    ...(now === undefined ? {} : { now })
  })
  if (!auth.allowed) throw new FulfillmentError(auth.code)
}
function rows(raw: unknown): unknown[] {
  const copied = catalogPolicyOwnJson(raw)
  if (
    !copied ||
    typeof copied !== 'object' ||
    !Object.hasOwn(copied, 'success') ||
    !Object.hasOwn(copied, 'results') ||
    (copied as { success: unknown }).success !== true ||
    !Array.isArray((copied as { results: unknown }).results)
  )
    throw new Error('fulfillment_provider_result_invalid')
  return (copied as { results: unknown[] }).results
}
function batchRows(raw: unknown, size: number): unknown[][] {
  if (
    !Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Array.prototype ||
    Reflect.ownKeys(raw).length !== size + 1 ||
    raw.length !== size
  )
    throw new Error('fulfillment_provider_result_invalid')
  return Array.from({ length: size }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(raw, String(i))
    if (!d || !Object.hasOwn(d, 'value')) throw new Error('fulfillment_provider_result_invalid')
    return rows(d.value)
  })
}
const auditColumns =
  'actor_id,order_id,location_id,action,input,expected_version,result_version,from_state,to_state,interrupted_state,reason,evidence,source_snapshot,response,created_at'
function conjunction(parts: string[]): string {
  if (parts.length === 1) return parts[0]!
  const middle = Math.floor(parts.length / 2)
  return `(${conjunction(parts.slice(0, middle))} AND ${conjunction(parts.slice(middle))})`
}
const auditMatch = conjunction(
  auditColumns
    .split(',')
    .map((name) => `a.${name} IS c.${name}`)
    .concat('a.command_id=c.id')
)
const auditProof = `EXISTS(SELECT 1 FROM order_fulfillment_audit a WHERE ${auditMatch})`
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.created_at<=${clock} AND s.expires_at>${clock}
 AND s.mfa_verified=1 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id
   AND p.permission_code='administration.manage' AND r.granted_at<=${clock} AND (r.expires_at IS NULL OR r.expires_at>${clock}))`
// Opt-in orchestration boundary only. Existing callers retain their historical
// policy; bulk preparation additionally requires a currently enrolled MFA actor.
const enrolledActorSql = `SELECT legacy.id FROM (${actorSql}) legacy JOIN identities enrolled ON enrolled.id=legacy.id JOIN identity_mfa m ON m.identity_id=enrolled.id WHERE enrolled.status='active' AND m.verified_at IS NOT NULL AND m.verified_at<=${clock}`
// Facts are deliberately isolated from mutable catalog/customer profiles. The
// actual order line and shipping/payment contract drives preparation, forever.
const factsSql = `scope AS MATERIALIZED (
 SELECT id FROM inventory_locations WHERE active=1 UNION SELECT location_id FROM inventory_balances
 UNION SELECT location_id FROM inventory_movements UNION SELECT location_id FROM inventory_reservation_lines
), facts AS MATERIALIZED (
 SELECT o.id AS order_id,o.status AS order_status,o.shipping_method_code AS shipping_method,
   COALESCE(f.status,'pending') AS state,f.interrupted_state,COALESCE(f.version,0) AS version,
   l.id AS location_id,l.code AS location_code,l.name AS location_name,
   ((SELECT count(*) FROM scope)=1 AND l.active=1 AND l.kind='warehouse'
     AND (SELECT count(DISTINCT location_id) FROM order_lines WHERE order_id=o.id)=1) AS warehouse_confirmed,
   COALESCE((p.status='paid' AND p.paid_gross_cents=o.total_gross_cents-${orderStoreCreditSql('o.id')} AND p.active_intent_id=claim.payment_intent_id
     AND pi.status='captured' AND pi.amount_gross_cents=p.paid_gross_cents AND pi.currency=o.currency
     AND EXISTS(SELECT 1 FROM payment_recovery_jobs job WHERE job.order_id=o.id AND job.payment_intent_id=pi.id AND job.status='completed')
     AND EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=o.id AND e.payment_intent_id=pi.id AND e.event_type='captured')),0) AS payment_confirmed,
   COALESCE((r.status='assigned' AND r.idempotency_key=r.id AND r.assigned_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM order_lines WHERE order_id=o.id)
     AND (SELECT count(*) FROM inventory_reservation_lines WHERE reservation_id=r.id)=
       (SELECT count(*) FROM (SELECT variant_id,location_id FROM order_lines WHERE order_id=o.id GROUP BY variant_id,location_id))
     AND NOT EXISTS(SELECT 1 FROM inventory_reservation_lines rl WHERE rl.reservation_id=r.id AND (
       rl.quantity<>COALESCE((SELECT sum(ol.quantity) FROM order_lines ol WHERE ol.order_id=o.id AND ol.variant_id=rl.variant_id AND ol.location_id=rl.location_id),-1)
       OR NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.idempotency_key=r.id||':allocate:'||rl.variant_id||':'||rl.location_id
         AND m.movement_type='allocate' AND m.reference_type='reservation' AND m.reference_id=r.id
         AND m.variant_id=rl.variant_id AND m.location_id=rl.location_id AND m.physical_delta=-rl.quantity AND m.reserved_delta=-rl.quantity
         AND m.created_at=r.assigned_at)
       OR NOT EXISTS(SELECT 1 FROM inventory_balances b WHERE b.variant_id=rl.variant_id AND b.location_id=rl.location_id
         AND b.physical_quantity=COALESCE((SELECT sum(m.physical_delta) FROM inventory_movements m WHERE m.variant_id=b.variant_id AND m.location_id=b.location_id),0)
         AND COALESCE((SELECT sum(m.reserved_delta) FROM inventory_movements m WHERE m.variant_id=b.variant_id AND m.location_id=b.location_id),0)
           =COALESCE((SELECT sum(active_line.quantity) FROM inventory_reservation_lines active_line JOIN inventory_reservations active ON active.id=active_line.reservation_id
             WHERE active_line.variant_id=b.variant_id AND active_line.location_id=b.location_id AND active.status='reserved'),0))))) ,0) AS inventory_confirmed,
   ((f.order_id IS NULL AND NOT EXISTS(SELECT 1 FROM order_fulfillment_commands WHERE order_id=o.id)) OR
     (f.order_id IS NOT NULL AND f.location_id=l.id AND EXISTS(SELECT 1 FROM order_fulfillment_commands c
       WHERE c.id=f.last_command_id AND c.order_id=o.id AND c.location_id=f.location_id AND c.result_version=f.version
       AND c.to_state=f.status AND c.interrupted_state IS f.interrupted_state AND c.created_at=f.updated_at AND ${auditProof})
       AND (SELECT count(*) FROM order_fulfillment_commands WHERE order_id=o.id)=f.version
       AND (SELECT count(*) FROM order_fulfillment_audit WHERE order_id=o.id)=f.version)) AS history_confirmed,
   json_object('order',json_object('id',o.id,'status',o.status,'currency',o.currency,'gross',o.total_gross_cents,
     'shippingMethod',o.shipping_method_code,'rateVersion',o.shipping_rate_version,'reservationId',o.reservation_id),
     'lines',json(COALESCE((SELECT json_group_array(json_object('index',line_index,'variantId',variant_id,'warehouseId',location_id,
       'quantity',quantity,'sku',sku,'name',name,'unitGross',unit_gross_cents,'gross',gross_cents,'priceVersion',price_version_id))
       FROM (SELECT * FROM order_lines WHERE order_id=o.id ORDER BY line_index)),'[]')),
     'payment',json_object('status',p.status,'intent',p.active_intent_id,'paid',p.paid_gross_cents,'updatedAt',p.updated_at,
       'claim',claim.payment_intent_id,'intentStatus',pi.status,'intentAmount',pi.amount_gross_cents,'intentCurrency',pi.currency),
     'reservation',json_object('id',r.id,'status',r.status,'assignedAt',r.assigned_at,'updatedAt',r.updated_at)) AS snapshot
 FROM orders o LEFT JOIN order_payment_states p ON p.order_id=o.id LEFT JOIN payment_fulfilment_claims claim ON claim.order_id=o.id
 LEFT JOIN payment_intents pi ON pi.id=claim.payment_intent_id AND pi.order_id=o.id
 LEFT JOIN inventory_reservations r ON r.id=o.reservation_id LEFT JOIN order_fulfillments f ON f.order_id=o.id
 LEFT JOIN inventory_locations l ON l.id=(SELECT location_id FROM order_lines WHERE order_id=o.id ORDER BY line_index LIMIT 1)
 WHERE o.id=?5
)`
const flag = z.number().int().min(0).max(1),
  name = z.string().min(1).max(200)
const sourceSchema = z
  .object({
    order_id: fulfillmentOrderIdSchema,
    order_status: z.enum(['awaiting_payment', 'cancelled']),
    shipping_method: z.string(),
    state: fulfillmentStateSchema,
    interrupted_state: fulfillmentStateSchema.nullable(),
    version: safe,
    location_id: name.nullable(),
    location_code: name.nullable(),
    location_name: name.nullable(),
    warehouse_confirmed: flag.nullable(),
    payment_confirmed: flag,
    inventory_confirmed: flag,
    history_confirmed: flag,
    snapshot: z.string()
  })
  .strict()
type Source = z.infer<typeof sourceSchema>
async function source(database: D1Database, id: string, now?: string): Promise<Source> {
  const result = rows(
    await database
      .prepare(`WITH ${factsSql} SELECT * FROM facts`)
      .bind(now ?? null, null, null, null, id)
      .all()
  )
  if (!result.length) throw new FulfillmentError('not_found')
  if (result.length !== 1) throw new Error('fulfillment_source_invalid')
  const parsed = sourceSchema.safeParse(result[0])
  if (!parsed.success) throw new Error('fulfillment_source_invalid')
  return parsed.data
}
function blockers(s: Source): FulfillmentBlocker[] {
  const result: FulfillmentBlocker[] = []
  if (s.order_status === 'cancelled') result.push('order_cancelled')
  if (s.payment_confirmed !== 1) result.push('payment_unconfirmed')
  if (s.inventory_confirmed !== 1) result.push('inventory_unconfirmed')
  if (s.warehouse_confirmed !== 1) result.push('warehouse_unavailable')
  if (!['pickup', 'own_delivery', 'parcel'].includes(s.shipping_method)) result.push('shipping_mode_unavailable')
  if (s.history_confirmed !== 1) result.push('history_unconfirmed')
  return result
}
function validate(s: Source, cmd: FulfillmentTransitionInput) {
  const blocked = blockers(s)
  if (blocked.length) throw new FulfillmentError(blocked[0]!)
  if (s.version !== cmd.expectedVersion || s.version >= Number.MAX_SAFE_INTEGER)
    throw new FulfillmentError('version_conflict')
  if (
    s.state === 'packed' &&
    ((cmd.action === 'ready_for_pickup' && s.shipping_method !== 'pickup') ||
      (cmd.action === 'in_transit' && s.shipping_method === 'pickup'))
  )
    throw new FulfillmentError('shipping_mode_mismatch')
  if (
    !allowedFulfillmentActions(
      s.state,
      s.interrupted_state,
      s.shipping_method as 'pickup' | 'own_delivery' | 'parcel'
    ).includes(cmd.action)
  )
    throw new FulfillmentError('invalid_transition')
}
function storedReceipt(raw: unknown): FulfillmentCommandReceipt {
  if (typeof raw !== 'string') throw new Error('fulfillment_receipt_invalid')
  const parsed: unknown = JSON.parse(raw),
    valid = fulfillmentCommandReceiptSchema.safeParse(parsed)
  if (!valid.success) throw new Error('fulfillment_receipt_invalid')
  return parsed as FulfillmentCommandReceipt
}
async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  now?: string,
  requireEnrolledMfa?: true
) {
  const result = rows(
    await database
      .prepare(
        `WITH actor AS (${requireEnrolledMfa ? enrolledActorSql : actorSql}) SELECT c.payload_hash,c.response,${auditProof} AS completed
    FROM actor JOIN order_fulfillment_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?5`
      )
      .bind(now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, key)
      .all()
  )
  await authorize(database, claims, now, requireEnrolledMfa)
  if (!result.length) return null
  const schema = z.object({ payload_hash: z.string().length(64), response: z.string(), completed: flag }).strict()
  if (result.length !== 1) throw new Error('fulfillment_replay_invalid')
  const parsed = schema.safeParse(result[0])
  if (!parsed.success) throw new Error('fulfillment_replay_invalid')
  if (parsed.data.payload_hash !== hash) throw new FulfillmentError('idempotency_conflict')
  if (parsed.data.completed !== 1) throw new FulfillmentError('history_unconfirmed')
  return storedReceipt(parsed.data.response)
}
/** Read-only exact receipt lookup for bounded orchestration. It never executes
 * a missing command, advances fulfillment, or changes inventory authority. */
export async function readD1AdminFulfillmentCommand(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOrderId: string,
  input: unknown,
  rawOptions: { idempotencyKey: string; now?: string; requireEnrolledMfa?: true }
): Promise<FulfillmentCommandReceipt | null> {
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
    id = checked(fulfillmentOrderIdSchema, rawOrderId),
    cmd = checked(fulfillmentTransitionInputSchema, input),
    options = checked(
      z
        .object({
          idempotencyKey: fulfillmentIdempotencyKeySchema,
          now: catalogPolicyInstantSchema.optional(),
          requireEnrolledMfa: z.literal(true).optional()
        })
        .strict(),
      rawOptions
    ),
    fresh = freshClock(options.now)
  await authorize(database, claims, fresh(), options.requireEnrolledMfa)
  const hash = await sha256Hex(canonicalJson({ orderId: id, input: cmd }))
  const receipt = await replay(database, claims, options.idempotencyKey, hash, fresh(), options.requireEnrolledMfa)
  if (
    receipt &&
    (receipt.orderId !== id || receipt.action !== cmd.action || receipt.version !== cmd.expectedVersion + 1)
  )
    throw new FulfillmentError('history_unconfirmed')
  return receipt
}
const requestSql = `request AS (SELECT ${Array.from({ length: 15 }, (_, i) => `?${i + 1} AS p${i + 1}`).join(',')})`
const owned = conjunction([
  'c.id=?9',
  'c.claim_nonce=?10',
  'c.actor_id=?3',
  'c.order_id=?5',
  'c.action=?6',
  'c.input=?7',
  'c.idempotency_key=?8',
  'c.payload_hash=?11'
])
const live = `s.order_status<>'cancelled' AND s.payment_confirmed=1 AND s.inventory_confirmed=1 AND s.warehouse_confirmed=1
  AND s.history_confirmed=1 AND s.shipping_method IN ('pickup','own_delivery','parcel')`
// Packing is a separate audited record, never a second source of preparation,
// payment or stock policy. These pure SQL/schema exports retain this authority.
export {
  auditProof as fulfillmentAuditProofSql,
  actorSql as fulfillmentActorSql,
  enrolledActorSql as fulfillmentEnrolledActorSql,
  factsSql as fulfillmentFactsSql,
  live as fulfillmentLiveSql,
  sourceSchema as fulfillmentSourceSchema,
  blockers as fulfillmentSourceBlockers,
  freshClock as fulfillmentFreshClock
}
const transition = `((s.state='pending' AND ?6 IN ('picking','exception')) OR (s.state='picking' AND ?6 IN ('packed','exception'))
 OR (s.state='packed' AND (?6='exception' OR (?6='ready_for_pickup' AND s.shipping_method='pickup') OR (?6='in_transit' AND s.shipping_method<>'pickup')))
 OR (s.state IN ('ready_for_pickup','in_transit') AND ?6 IN ('delivered','exception'))
 OR (s.state='exception' AND ?6=CASE s.interrupted_state WHEN 'pending' THEN 'picking' ELSE s.interrupted_state END))`
const precondition = `${live} AND s.snapshot=?12 AND s.version=?13 AND s.version<9007199254740991 AND ${transition}`
function constraintFailure(raw: unknown) {
  if (isD1CheckConstraintFailure(raw)) return true
  if (!(raw instanceof Error)) return false
  const msg: unknown = Object.getOwnPropertyDescriptor(raw, 'message')?.value
  return (
    typeof msg === 'string' &&
    [
      'order_fulfillment_commands_immutable',
      'order_fulfillment_projection_invalid',
      'order_fulfillment_transition_invalid',
      'order_fulfillment_audit_invalid',
      'order_fulfillment_audit_immutable'
    ].some(
      (name) =>
        msg === name ||
        msg === `D1_ERROR: ${name}: SQLITE_CONSTRAINT` ||
        msg === `D1_ERROR: ${name}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
    )
  )
}
/** One guarded atomic D1 batch, with live authorization and private claim nonce.
 * There is intentionally NO inventory gateway: allocation happened on payment. */
export async function executeD1AdminFulfillmentCommand(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOrderId: string,
  input: unknown,
  rawOptions: { idempotencyKey: string; now?: string; requireEnrolledMfa?: true }
): Promise<FulfillmentCommandReceipt> {
  const options = checked(
    z
      .object({
        idempotencyKey: fulfillmentIdempotencyKeySchema,
        now: catalogPolicyInstantSchema.optional(),
        requireEnrolledMfa: z.literal(true).optional()
      })
      .strict(),
    rawOptions
  )
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
    id = checked(fulfillmentOrderIdSchema, rawOrderId),
    cmd = checked(fulfillmentTransitionInputSchema, input),
    fresh = freshClock(options.now)
  await authorize(database, claims, fresh(), options.requireEnrolledMfa)
  const serialized = canonicalJson(cmd),
    hash = await sha256Hex(canonicalJson({ orderId: id, input: cmd })),
    old = await replay(database, claims, options.idempotencyKey, hash, fresh(), options.requireEnrolledMfa)
  if (old) return old
  const s = await source(database, id, fresh())
  await authorize(database, claims, fresh(), options.requireEnrolledMfa)
  validate(s, cmd)
  const commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const params = [
    fresh() ?? null,
    claims.sessionId,
    claims.identityId,
    claims.sessionVersion,
    id,
    cmd.action,
    serialized,
    options.idempotencyKey,
    commandId,
    nonce,
    hash,
    s.snapshot,
    cmd.expectedVersion,
    crypto.randomUUID(),
    cmd.evidence ?? null
  ]
  const prefix = `WITH ${requestSql},actor AS (${options.requireEnrolledMfa ? enrolledActorSql : actorSql}),${factsSql}`
  const commandPrefix = `${prefix},owned AS MATERIALIZED (SELECT c.* FROM order_fulfillment_commands c JOIN actor ON actor.id=c.actor_id WHERE ${owned})`
  const projectionProof = `EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id=c.order_id AND f.location_id=c.location_id AND f.version=c.result_version AND f.last_command_id=c.id AND f.status=c.to_state AND f.interrupted_state IS c.interrupted_state AND f.updated_at=c.created_at)`
  const sql = [
    `${prefix} INSERT INTO order_fulfillment_commands(id,claim_nonce,actor_id,order_id,location_id,action,idempotency_key,payload_hash,input,expected_version,result_version,from_state,to_state,interrupted_state,reason,evidence,source_snapshot,response,created_at)
     SELECT ?9,?10,actor.id,s.order_id,s.location_id,?6,?8,?11,?7,s.version,s.version+1,s.state,?6,CASE WHEN ?6='exception' THEN s.state ELSE NULL END,
       json_extract(?7,'$.reason'),?15,s.snapshot,json_object('source','cloudflare','action',?6,'commandId',?9,'orderId',s.order_id,'warehouseId',s.location_id,
       'state',?6,'interruptedState',CASE WHEN ?6='exception' THEN s.state ELSE NULL END,'version',s.version+1,'inventoryEffect','none','updated',json('true')),${clock}
     FROM facts s JOIN actor WHERE ${precondition}`,
    `${commandPrefix} UPDATE order_fulfillments SET status=(SELECT to_state FROM owned),interrupted_state=(SELECT interrupted_state FROM owned),
      version=version+1,last_command_id=?9,updated_at=(SELECT created_at FROM owned) WHERE order_id=?5 AND version=?13
      AND EXISTS(SELECT 1 FROM owned c JOIN facts s ON s.order_id=c.order_id WHERE ${precondition.replace('s.history_confirmed=1 AND ', '')})`,
    `${commandPrefix} INSERT INTO order_fulfillments(order_id,location_id,status,interrupted_state,version,last_command_id,created_at,updated_at)
      SELECT c.order_id,c.location_id,c.to_state,c.interrupted_state,c.result_version,c.id,c.created_at,c.created_at FROM owned c JOIN facts s ON s.order_id=c.order_id
      WHERE c.expected_version=0 AND NOT EXISTS(SELECT 1 FROM order_fulfillments WHERE order_id=c.order_id)
        AND s.snapshot=c.source_snapshot AND s.payment_confirmed=1 AND s.inventory_confirmed=1 AND s.warehouse_confirmed=1 AND s.order_status<>'cancelled'`,
    `${commandPrefix} INSERT INTO order_fulfillment_audit(id,command_id,${auditColumns})
      SELECT ?14,c.id,${auditColumns
        .split(',')
        .map((name) => `c.${name}`)
        .join(',')} FROM owned c JOIN facts s ON s.order_id=c.order_id
      WHERE ${projectionProof} AND s.snapshot=c.source_snapshot AND s.payment_confirmed=1 AND s.inventory_confirmed=1 AND s.warehouse_confirmed=1 AND s.order_status<>'cancelled'`,
    `${commandPrefix} INSERT INTO order_fulfillment_guards(id,satisfied) SELECT ?9,0 WHERE NOT EXISTS(
      SELECT 1 FROM owned c JOIN facts s ON s.order_id=c.order_id WHERE ${projectionProof} AND ${auditProof}
        AND ${live} AND s.snapshot=c.source_snapshot)`
  ]
  const email = await prepareOrderOperationsEnqueue(database, {
    orderId: id,
    commandId,
    kind: 'fulfillment',
    now: options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  })
  try {
    batchRows(
      await database.batch([...sql.map((statement) => database.prepare(statement).bind(...params)), email]),
      sql.length + 1
    )
  } catch (failure) {
    if (!constraintFailure(failure)) throw failure
    await authorize(database, claims, fresh(), options.requireEnrolledMfa)
    const winner = await replay(database, claims, options.idempotencyKey, hash, fresh(), options.requireEnrolledMfa)
    if (winner) return winner
    const latest = await source(database, id, fresh())
    await authorize(database, claims, fresh(), options.requireEnrolledMfa)
    validate(latest, cmd)
    throw new FulfillmentError('conflict')
  }
  const completed = await replay(database, claims, options.idempotencyKey, hash, fresh(), options.requireEnrolledMfa)
  if (!completed) throw new Error('fulfillment_completion_unconfirmed')
  return completed
}

/** Private operational data only. Failed/changed provider results never become
 * fictitious pending orders or empty history; authority is refreshed on return. */
export async function readD1AdminFulfillment(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOrderId: string,
  rawOptions: { page: number; perPage: number; now?: string }
): Promise<AdminOrderFulfillment> {
  const options = checked(
    z
      .object({ page: positive.max(1_000_000), perPage: positive.max(50), now: catalogPolicyInstantSchema.optional() })
      .strict(),
    rawOptions
  )
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
    id = checked(fulfillmentOrderIdSchema, rawOrderId),
    fresh = freshClock(options.now)
  await authorize(database, claims, fresh())
  const s = await source(database, id, fresh())
  await authorize(database, claims, fresh())
  const result = rows(
    await database
      .prepare(
        `SELECT c.id AS commandId,c.actor_id AS actorId,c.action,c.from_state AS fromState,c.to_state AS toState,
    c.interrupted_state AS interruptedState,c.result_version AS version,c.reason,c.evidence,c.created_at AS createdAt
    FROM order_fulfillment_commands c WHERE c.order_id=?1 AND ${auditProof} ORDER BY c.result_version DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(id, options.perPage, (options.page - 1) * options.perPage)
      .all()
  )
  await authorize(database, claims, fresh())
  const latest = await source(database, id, fresh())
  await authorize(database, claims, fresh())
  if (
    latest.snapshot !== s.snapshot ||
    latest.version !== s.version ||
    latest.state !== s.state ||
    latest.history_confirmed !== s.history_confirmed
  )
    throw new FulfillmentError('version_conflict')
  const blocked = blockers(s),
    method = ['pickup', 'own_delivery', 'parcel'].includes(s.shipping_method)
      ? (s.shipping_method as 'pickup' | 'own_delivery' | 'parcel')
      : null
  const dto = {
    source: 'cloudflare',
    orderId: id,
    purchaseOrderReference: await readOrderPurchaseOrderReference(database, id),
    warehouse: s.warehouse_confirmed === 1 ? { id: s.location_id, code: s.location_code, name: s.location_name } : null,
    shippingMethod: method,
    state: s.state,
    interruptedState: s.interrupted_state,
    version: s.version,
    readiness: { ready: blocked.length === 0, blockers: blocked },
    capabilities: {
      fulfillmentRead: true,
      fulfillmentTransitions: blocked.length === 0 && s.state !== 'delivered',
      allowedActions:
        blocked.length === 0 && method ? allowedFulfillmentActions(s.state, s.interrupted_state, method) : []
    },
    inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement',
    timeline: {
      items: result,
      pagination: {
        page: options.page,
        perPage: options.perPage,
        total: s.version,
        pages: Math.ceil(s.version / options.perPage)
      }
    },
    evaluatedAt: instant(fresh())
  }
  const parsed = adminOrderFulfillmentSchema.safeParse(dto)
  if (!parsed.success) throw new Error('fulfillment_dto_invalid')
  await authorize(database, claims, fresh())
  return parsed.data
}
