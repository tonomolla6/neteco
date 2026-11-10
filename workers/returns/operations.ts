import { z } from 'zod'
import { prepareOrderReturnEnqueue } from '../communications/order-return-email'
import {
  adminOrderReturnSchema,
  adminReturnListSchema,
  customerOrderReturnSchema,
  customerOrderReturnsSchema,
  returnCommandReceiptSchema,
  returnRequestInputSchema,
  returnTransitionInputSchema,
  returnOrderIdSchema,
  returnPublicRefSchema,
  returnIdempotencyKeySchema,
  returnStateSchema,
  allowedReturnActions,
  type AdminOrderReturn,
  type AdminReturnList,
  type CustomerOrderReturns,
  type CustomerOrderReturn,
  type ReturnCommandReceipt,
  type ReturnRequestInput,
  type ReturnTransitionInput,
  type ReturnBlocker
} from '../../shared/order-returns'
import {
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase as guardedDatabase } from '../fiscal/d1-boundary'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { orderStoreCreditSql } from '../pricing/order-store-credit-sql'

export type ReturnsErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'quantity_unavailable'
  | 'line_not_found'
  | 'order_cancelled'
  | 'payment_unconfirmed'
  | 'delivery_unconfirmed'
  | 'warehouse_unavailable'
  | 'history_unconfirmed'
  | 'conflict'
export class ReturnsError extends Error {
  constructor(readonly code: ReturnsErrorCode) {
    super(code)
    this.name = 'ReturnsError'
  }
}
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  positive = integer.min(1),
  flag = z.number().int().min(0).max(1)
const claimsSchema = z
  .object({ identityId: catalogPolicyUuidSchema, sessionId: catalogPolicyUuidSchema, sessionVersion: positive })
  .strict()
const paginationOptions = z
  .object({ page: positive.max(1_000_000), perPage: positive.max(50), now: catalogPolicyInstantSchema.optional() })
  .strict()
const commandOptions = z
  .object({ idempotencyKey: returnIdempotencyKeySchema, now: catalogPolicyInstantSchema.optional() })
  .strict()
type Actor = { claims: VerifiedSessionClaims; customerId: string | null }
type Clock = () => string
function checked<T, I>(schema: z.ZodType<T, I>, value: unknown, code: ReturnsErrorCode = 'invalid_input'): T {
  let data: unknown
  try {
    data = catalogPolicyOwnJson(value)
  } catch {
    throw new ReturnsError(code)
  }
  const result = schema.safeParse(data)
  if (!result.success) throw new ReturnsError(code)
  return result.data
}
function freshClock(input?: string): Clock {
  const start = Date.now()
  return () =>
    new Date(input === undefined ? Date.now() : Date.parse(input) + Math.max(0, Date.now() - start))
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
}
async function authorize(database: D1Database, actor: Actor, now: Clock) {
  if (actor.customerId === null) {
    const result = await authorizeD1Session(database, actor.claims, 'administration.manage', {
      requireMfa: true,
      now: now()
    })
    if (!result.allowed) throw new ReturnsError(result.code)
  } else if ((await activeOrderCustomerId(database, actor.claims, now())) !== actor.customerId)
    throw new ReturnsError('unauthenticated')
}
async function actorFor(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  kind: 'admin' | 'customer',
  now: Clock
): Promise<Actor> {
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated')
  const customerId = kind === 'customer' ? await activeOrderCustomerId(database, claims, now()) : null
  if (kind === 'customer' && customerId === null) throw new ReturnsError('unauthenticated')
  const actor = { claims, customerId }
  await authorize(database, actor, now)
  return actor
}
const clockSql = `COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
const actorSql = `SELECT i.id,i.customer_id FROM auth_sessions session JOIN identities i ON i.id=session.identity_id
 WHERE session.id=?2 AND session.identity_id=?3 AND session.session_version=?4 AND i.session_version=session.session_version
   AND session.revoked_at IS NULL AND session.created_at<=${clockSql} AND session.expires_at>${clockSql}
   AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clockSql}
   AND ((?5 IS NULL AND session.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_roles role JOIN role_permissions permission ON permission.role_code=role.role_code
     WHERE role.identity_id=i.id AND permission.permission_code='administration.manage' AND role.granted_at<=${clockSql} AND (role.expires_at IS NULL OR role.expires_at>${clockSql})))
     OR (?5 IS NOT NULL AND i.status='active' AND i.customer_id=?5 AND EXISTS(SELECT 1 FROM customers WHERE id=?5 AND status='active')))`
const auditProof = `EXISTS(SELECT 1 FROM order_return_events event WHERE event.command_id=c.id AND event.return_id=c.return_id
 AND event.actor_id=c.actor_id AND event.actor_type=c.actor_type AND event.order_id=c.order_id AND event.action=c.action
 AND event.version=c.result_version AND event.input=c.input AND event.response=c.response AND event.public_message=c.public_message AND event.created_at=c.created_at)`
const factsSql = `scope AS MATERIALIZED (SELECT id FROM inventory_locations WHERE active=1 UNION SELECT location_id FROM inventory_balances
 UNION SELECT location_id FROM inventory_movements UNION SELECT location_id FROM inventory_reservation_lines), facts AS MATERIALIZED (
 SELECT o.id AS order_id,o.status AS order_status,o.currency,o.total_gross_cents,location.id AS location_id,location.name AS location_name,
 (SELECT count(*) FROM order_return_commands WHERE order_id=o.id) AS order_version,
 COALESCE((p.status='paid' AND p.active_intent_id=claim.payment_intent_id AND p.paid_gross_cents=o.total_gross_cents-${orderStoreCreditSql('o.id')}
   AND payment.status='captured' AND payment.amount_gross_cents=p.paid_gross_cents AND payment.currency=o.currency
   AND reservation.status='assigned' AND EXISTS(SELECT 1 FROM payment_recovery_jobs WHERE order_id=o.id AND payment_intent_id=payment.id AND status='completed')
   AND EXISTS(SELECT 1 FROM payment_events WHERE order_id=o.id AND payment_intent_id=payment.id AND event_type='captured')),0) AS payment_confirmed,
 COALESCE((fulfillment.status='delivered' AND EXISTS(SELECT 1 FROM order_fulfillment_commands delivered JOIN order_fulfillment_audit audit ON audit.command_id=delivered.id
   WHERE delivered.id=fulfillment.last_command_id AND delivered.order_id=o.id AND delivered.location_id=location.id
     AND delivered.action='delivered' AND delivered.to_state='delivered' AND delivered.result_version=fulfillment.version
     AND delivered.created_at=fulfillment.updated_at AND audit.response=delivered.response AND audit.input=delivered.input
     AND audit.result_version=fulfillment.version AND audit.to_state='delivered')
   AND fulfillment.version=(SELECT count(*) FROM order_fulfillment_commands WHERE order_id=o.id)
   AND fulfillment.version=(SELECT count(*) FROM order_fulfillment_audit WHERE order_id=o.id)),0) AS delivery_confirmed,
 COALESCE(((SELECT count(*) FROM scope)=1 AND location.active=1 AND location.kind='warehouse'
   AND (SELECT count(DISTINCT location_id) FROM order_lines WHERE order_id=o.id)=1),0) AS warehouse_confirmed,
 ((SELECT count(*) FROM order_return_commands WHERE order_id=o.id)=COALESCE((SELECT SUM(version) FROM order_returns WHERE order_id=o.id),0)
   AND NOT EXISTS(SELECT 1 FROM order_returns r WHERE r.order_id=o.id AND (
     r.version<>(SELECT count(*) FROM order_return_commands WHERE return_id=r.id)
     OR r.version<>(SELECT count(*) FROM order_return_events WHERE return_id=r.id)
     OR NOT EXISTS(SELECT 1 FROM order_return_commands c WHERE c.id=r.last_command_id AND c.return_id=r.id AND c.order_id=r.order_id
       AND c.public_ref=r.public_ref AND c.location_id=r.location_id AND c.to_state=r.state AND c.result_version=r.version AND c.created_at=r.updated_at AND ${auditProof})
     OR (SELECT count(*) FROM order_return_lines WHERE return_id=r.id)<>COALESCE((SELECT json_array_length(input,'$.lines') FROM order_return_commands WHERE return_id=r.id AND action='requested'),-1)
     OR EXISTS(SELECT 1 FROM order_return_lines line WHERE line.return_id=r.id AND (line.order_id<>r.order_id OR line.last_command_id<>r.last_command_id
       OR line.authorized_quantity<>COALESCE((SELECT json_extract(item.value,'$.quantity') FROM order_return_commands command JOIN json_each(command.input,'$.lines') item
         WHERE command.return_id=r.id AND command.action='approved' AND json_extract(item.value,'$.lineIndex')=line.line_index),0)
       OR line.received_quantity<>COALESCE((SELECT SUM(json_extract(item.value,'$.quantity')) FROM order_return_commands command JOIN json_each(command.input,'$.lines') item
         WHERE command.return_id=r.id AND command.action='received' AND json_extract(item.value,'$.lineIndex')=line.line_index),0)
       OR line.inspected_quantity<>COALESCE((SELECT SUM(json_extract(item.value,'$.quantity')) FROM order_return_commands command JOIN json_each(command.input,'$.lines') item
         WHERE command.return_id=r.id AND command.action='inspected' AND json_extract(item.value,'$.lineIndex')=line.line_index),0)
       OR line.claimed_quantity<>CASE WHEN r.state='rejected' THEN 0 WHEN r.state='requested' THEN line.requested_quantity ELSE line.authorized_quantity END))))
   AND NOT EXISTS(SELECT 1 FROM order_lines line WHERE line.order_id=o.id AND line.quantity<COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines WHERE order_id=o.id AND line_index=line.line_index),0))) AS history_confirmed,
 json_object('orderId',o.id,'customerId',o.customer_id,'status',o.status,'currency',o.currency,'gross',o.total_gross_cents,
   'reservationId',o.reservation_id,'locationId',location.id,'paymentIntentId',claim.payment_intent_id,'paidGross',p.paid_gross_cents,
   'deliveredCommand',fulfillment.last_command_id,'deliveredAt',fulfillment.updated_at,
   'lines',json(COALESCE((SELECT json_group_array(json_object('index',line_index,'sku',sku,'name',name,'quantity',quantity,
     'unitGross',unit_gross_cents,'gross',gross_cents,'net',net_cents,'tax',tax_cents,'rate',tax_rate_basis_points,'locationId',location_id,'variantId',variant_id,'priceVersion',price_version_id))
     FROM (SELECT * FROM order_lines WHERE order_id=o.id ORDER BY line_index)),'[]'))) AS snapshot,
 COALESCE((SELECT json_group_array(json_object('lineIndex',line.line_index,'sku',line.sku,'name',line.name,'purchasedQuantity',line.quantity,
   'claimedQuantity',COALESCE((SELECT SUM(claimed_quantity) FROM order_return_lines WHERE order_id=o.id AND line_index=line.line_index),0),
   'unitGrossCents',line.unit_gross_cents,'lineGrossCents',line.gross_cents,'currency',o.currency)) FROM order_lines line WHERE line.order_id=o.id ORDER BY line.line_index),'[]') AS lines_json
 FROM orders o JOIN actor ON (?5 IS NULL OR o.customer_id=actor.customer_id)
 LEFT JOIN order_payment_states p ON p.order_id=o.id LEFT JOIN payment_fulfilment_claims claim ON claim.order_id=o.id
 LEFT JOIN payment_intents payment ON payment.id=claim.payment_intent_id AND payment.order_id=o.id
 LEFT JOIN inventory_reservations reservation ON reservation.id=o.reservation_id LEFT JOIN order_fulfillments fulfillment ON fulfillment.order_id=o.id
 LEFT JOIN inventory_locations location ON location.id=(SELECT location_id FROM order_lines WHERE order_id=o.id ORDER BY line_index LIMIT 1)
 WHERE o.id=?6)`
const sourceSchema = z
  .object({
    order_id: returnOrderIdSchema,
    order_status: z.enum(['awaiting_payment', 'cancelled']),
    currency: z.literal('EUR'),
    total_gross_cents: integer,
    location_id: z.string().min(1).nullable(),
    location_name: z.string().min(1).nullable(),
    order_version: integer,
    payment_confirmed: flag,
    delivery_confirmed: flag,
    warehouse_confirmed: flag,
    history_confirmed: flag,
    snapshot: z.string(),
    lines_json: z.string()
  })
  .strict()
const budgetLineSchema = z
  .object({
    lineIndex: integer.max(99),
    sku: z.string().min(1),
    name: z.string().min(1),
    purchasedQuantity: positive.max(999),
    claimedQuantity: integer.max(999),
    unitGrossCents: integer,
    lineGrossCents: integer,
    currency: z.literal('EUR')
  })
  .strict()
  .refine((line) => line.claimedQuantity <= line.purchasedQuantity)
type Source = z.infer<typeof sourceSchema> & { lines: z.infer<typeof budgetLineSchema>[] }
function actorParams(actor: Actor, now: Clock, orderId: string | null) {
  return [
    now(),
    actor.claims.sessionId,
    actor.claims.identityId,
    actor.claims.sessionVersion,
    actor.customerId,
    orderId
  ]
}
async function source(database: D1Database, actor: Actor, orderId: string, now: Clock): Promise<Source> {
  const result = (
    await database
      .prepare(`WITH actor AS (${actorSql}),${factsSql} SELECT * FROM facts`)
      .bind(...actorParams(actor, now, orderId))
      .all()
  ).results
  await authorize(database, actor, now)
  if (!result.length) throw new ReturnsError('not_found')
  if (result.length !== 1) throw new Error('returns_source_unconfirmed')
  const data = checked(sourceSchema, result[0], 'history_unconfirmed'),
    lines = checked(z.array(budgetLineSchema).min(1).max(100), JSON.parse(data.lines_json), 'history_unconfirmed')
  if (new Set(lines.map((line) => line.lineIndex)).size !== lines.length) throw new ReturnsError('history_unconfirmed')
  return { ...data, lines }
}
function blockers(s: Source): ReturnBlocker[] {
  const output: ReturnBlocker[] = []
  if (s.order_status === 'cancelled') output.push('order_cancelled')
  if (s.payment_confirmed !== 1) output.push('payment_unconfirmed')
  if (s.delivery_confirmed !== 1) output.push('delivery_unconfirmed')
  if (s.warehouse_confirmed !== 1) output.push('warehouse_unavailable')
  if (s.history_confirmed !== 1) output.push('history_unconfirmed')
  return output
}
const recordSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    public_ref: returnPublicRefSchema,
    order_id: returnOrderIdSchema,
    location_id: z.string().min(1),
    state: returnStateSchema,
    version: positive,
    reason: z.string(),
    last_command_id: catalogPolicyUuidSchema,
    created_at: catalogPolicyInstantSchema,
    updated_at: catalogPolicyInstantSchema
  })
  .strict()
type RecordView = z.infer<typeof recordSchema>
async function record(database: D1Database, actor: Actor, ref: string, now: Clock): Promise<RecordView> {
  const raw = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT r.* FROM order_returns r JOIN orders o ON o.id=r.order_id JOIN actor ON (?5 IS NULL OR o.customer_id=actor.customer_id) WHERE r.public_ref=?6`
    )
    .bind(...actorParams(actor, now, ref))
    .first()
  await authorize(database, actor, now)
  if (raw === null) throw new ReturnsError('not_found')
  return checked(recordSchema, raw, 'history_unconfirmed')
}
const lineSchema = z
  .object({
    lineIndex: integer.max(99),
    sku: z.string(),
    name: z.string(),
    purchasedQuantity: positive,
    requestedQuantity: positive,
    authorizedQuantity: integer,
    receivedQuantity: integer,
    inspectedQuantity: integer,
    claimedQuantity: integer,
    unitGrossCents: integer,
    lineGrossCents: integer,
    currency: z.literal('EUR')
  })
  .strict()
async function returnLines(database: D1Database, r: RecordView) {
  const result = (
    await database
      .prepare(
        `SELECT line.line_index AS lineIndex,ordered.sku,ordered.name,ordered.quantity AS purchasedQuantity,line.requested_quantity AS requestedQuantity,
    line.authorized_quantity AS authorizedQuantity,line.received_quantity AS receivedQuantity,line.inspected_quantity AS inspectedQuantity,line.claimed_quantity AS claimedQuantity,
    ordered.unit_gross_cents AS unitGrossCents,ordered.gross_cents AS lineGrossCents,'EUR' AS currency FROM order_return_lines line JOIN order_lines ordered ON ordered.order_id=line.order_id AND ordered.line_index=line.line_index
    WHERE line.return_id=?1 AND line.order_id=?2 ORDER BY line.line_index LIMIT 101`
      )
      .bind(r.id, r.order_id)
      .all()
  ).results
  return checked(z.array(lineSchema).min(1).max(100), result, 'history_unconfirmed')
}
function validateRequest(s: Source, cmd: ReturnRequestInput) {
  const blocked = blockers(s)
  if (blocked.length) throw new ReturnsError(blocked[0]!)
  if (s.order_version !== cmd.expectedVersion || s.order_version >= Number.MAX_SAFE_INTEGER)
    throw new ReturnsError('version_conflict')
  for (const line of cmd.lines) {
    const historical = s.lines.find((item) => item.lineIndex === line.lineIndex)
    if (!historical) throw new ReturnsError('line_not_found')
    if (line.quantity > historical.purchasedQuantity - historical.claimedQuantity)
      throw new ReturnsError('quantity_unavailable')
  }
}
function validateTransition(s: Source, r: RecordView, lines: z.infer<typeof lineSchema>[], cmd: ReturnTransitionInput) {
  const blocked = blockers(s)
  if (blocked.length) throw new ReturnsError(blocked[0]!)
  if (
    r.version !== cmd.expectedVersion ||
    r.version >= Number.MAX_SAFE_INTEGER ||
    s.order_version >= Number.MAX_SAFE_INTEGER
  )
    throw new ReturnsError('version_conflict')
  const allowed = allowedReturnActions(
    r.state,
    lines.every((line) => line.receivedQuantity === line.authorizedQuantity),
    lines.every((line) => line.inspectedQuantity === line.receivedQuantity)
  )
  if (!allowed.includes(cmd.action)) throw new ReturnsError('invalid_transition')
  if ('lines' in cmd) {
    if (cmd.action === 'approved' && cmd.lines.length !== lines.length) throw new ReturnsError('line_not_found')
    for (const line of cmd.lines) {
      const original = lines.find((item) => item.lineIndex === line.lineIndex)
      if (!original) throw new ReturnsError('line_not_found')
      const available =
        cmd.action === 'approved'
          ? original.requestedQuantity
          : cmd.action === 'received'
            ? original.authorizedQuantity - original.receivedQuantity
            : original.receivedQuantity - original.inspectedQuantity
      if (line.quantity > available) throw new ReturnsError('quantity_unavailable')
    }
  }
}
async function replay(
  database: D1Database,
  actor: Actor,
  key: string,
  hash: string,
  now: Clock
): Promise<ReturnCommandReceipt | null> {
  const result = (
    await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,${auditProof} AS completed FROM order_return_commands c JOIN actor ON actor.id=c.actor_id
    JOIN orders o ON o.id=c.order_id AND (?5 IS NULL OR o.customer_id=actor.customer_id) WHERE c.idempotency_key=?6`
      )
      .bind(...actorParams(actor, now, key))
      .all()
  ).results
  await authorize(database, actor, now)
  if (!result.length) return null
  if (result.length !== 1) throw new Error('returns_replay_unconfirmed')
  const row = checked(
    z.object({ payload_hash: z.string().length(64), response: z.string(), completed: flag }).strict(),
    result[0],
    'history_unconfirmed'
  )
  if (row.payload_hash !== hash) throw new ReturnsError('idempotency_conflict')
  if (row.completed !== 1) throw new ReturnsError('history_unconfirmed')
  return checked(returnCommandReceiptSchema, JSON.parse(row.response), 'history_unconfirmed')
}
const live = `s.order_status<>'cancelled' AND s.payment_confirmed=1 AND s.delivery_confirmed=1 AND s.warehouse_confirmed=1`
const ownedSql = `owned AS MATERIALIZED (SELECT c.* FROM order_return_commands c JOIN actor ON actor.id=c.actor_id JOIN orders o ON o.id=c.order_id
 WHERE c.id=?16 AND c.claim_nonce=?17 AND c.order_id=?6 AND c.return_id=?10 AND c.public_ref=?11 AND c.action=?12 AND c.input=?13
 AND c.idempotency_key=?14 AND c.payload_hash=?15 AND c.source_snapshot=?7 AND (?5 IS NULL OR o.customer_id=actor.customer_id))`
function knownConstraint(value: unknown) {
  if (isD1CheckConstraintFailure(value)) return true
  const message = value instanceof Error ? Object.getOwnPropertyDescriptor(value, 'message')?.value : undefined
  return (
    typeof message === 'string' &&
    [
      'order_return_commands_immutable',
      'order_return_projection_invalid',
      'order_return_projection_immutable',
      'order_return_line_projection_invalid',
      'order_return_quantity_unavailable',
      'order_return_transition_invalid',
      'order_return_event_invalid'
    ].some(
      (name) =>
        message === name ||
        message === `D1_ERROR: ${name}: SQLITE_CONSTRAINT` ||
        message === `D1_ERROR: ${name}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
    )
  )
}
async function commit(
  database: D1Database,
  actor: Actor,
  s: Source,
  r: RecordView | null,
  cmd: ReturnRequestInput | ReturnTransitionInput,
  key: string,
  hash: string,
  now: Clock
) {
  const action = 'action' in cmd ? cmd.action : 'requested',
    id = r?.id ?? crypto.randomUUID(),
    ref = r?.public_ref ?? `RMA-${crypto.randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase()}`,
    commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID(),
    input = canonicalJson(cmd),
    expected = r?.version ?? 0,
    message = 'publicMessage' in cmd ? cmd.publicMessage : 'Solicitud registrada. Pendiente de revisión documentada.'
  const receipt = checked(returnCommandReceiptSchema, {
    source: 'cloudflare',
    commandId,
    returnId: id,
    publicRef: ref,
    orderId: s.order_id,
    action,
    state: action,
    version: expected + 1,
    orderVersion: s.order_version + 1,
    inventoryEffect: 'none',
    custody: 'non_sellable',
    updated: true
  })
  const params = [
    ...actorParams(actor, now, s.order_id),
    s.snapshot,
    s.order_version,
    expected,
    id,
    ref,
    action,
    input,
    key,
    hash,
    commandId,
    nonce,
    message,
    r?.state ?? null,
    s.location_id,
    canonicalJson(receipt)
  ]
  const prefix = `WITH request AS (SELECT ?21 AS receipt),actor AS (${actorSql}),${factsSql}`,
    ownPrefix = `${prefix},${ownedSql}`
  const projection = `EXISTS(SELECT 1 FROM order_returns r WHERE r.id=c.return_id AND r.last_command_id=c.id AND r.version=c.result_version AND r.state=c.to_state AND r.updated_at=c.created_at)`
  const selectedQuantity = `COALESCE((SELECT json_extract(item.value,'$.quantity') FROM json_each(?13,'$.lines') item WHERE json_extract(item.value,'$.lineIndex')=order_return_lines.line_index),0)`
  const sql = [
    `${prefix} INSERT INTO order_return_commands(id,claim_nonce,actor_id,actor_type,order_id,return_id,public_ref,location_id,action,idempotency_key,payload_hash,input,expected_version,result_version,expected_order_version,result_order_version,from_state,to_state,reason,public_message,source_snapshot,response,created_at)
     SELECT ?16,?17,actor.id,CASE WHEN ?5 IS NULL THEN 'admin' ELSE 'customer' END,s.order_id,?10,?11,s.location_id,?12,?14,?15,?13,?9,?9+1,?8,?8+1,?19,?12,json_extract(?13,'$.reason'),?18,s.snapshot,?21,${clockSql}
     FROM facts s JOIN actor WHERE ${live} AND s.history_confirmed=1 AND s.snapshot=?7 AND s.order_version=?8`,
    `${ownPrefix} INSERT INTO order_returns(id,public_ref,order_id,location_id,state,version,reason,last_command_id,created_at,updated_at)
     SELECT c.return_id,c.public_ref,c.order_id,c.location_id,'requested',1,c.reason,c.id,c.created_at,c.created_at FROM owned c JOIN facts s ON s.order_id=c.order_id
     WHERE c.action='requested' AND ${live} AND s.snapshot=c.source_snapshot`,
    `${ownPrefix} UPDATE order_returns SET state=?12,version=version+1,last_command_id=?16,updated_at=(SELECT created_at FROM owned)
     WHERE id=?10 AND version=?9 AND state=?19 AND ?12<>'requested' AND EXISTS(SELECT 1 FROM owned c JOIN facts s ON s.order_id=c.order_id WHERE ${live} AND s.snapshot=c.source_snapshot)`,
    `${ownPrefix} INSERT INTO order_return_lines(return_id,order_id,line_index,requested_quantity,claimed_quantity,last_command_id)
     SELECT c.return_id,c.order_id,json_extract(item.value,'$.lineIndex'),json_extract(item.value,'$.quantity'),json_extract(item.value,'$.quantity'),c.id
     FROM owned c JOIN json_each(c.input,'$.lines') item JOIN facts s ON s.order_id=c.order_id WHERE c.action='requested' AND ${projection} AND ${live} AND s.snapshot=c.source_snapshot`,
    `${ownPrefix} UPDATE order_return_lines SET authorized_quantity=CASE WHEN ?12='approved' THEN ${selectedQuantity} ELSE authorized_quantity END,
     received_quantity=received_quantity+CASE WHEN ?12='received' THEN ${selectedQuantity} ELSE 0 END,
     inspected_quantity=inspected_quantity+CASE WHEN ?12='inspected' THEN ${selectedQuantity} ELSE 0 END,
     claimed_quantity=CASE WHEN ?12='approved' THEN ${selectedQuantity} WHEN ?12='rejected' THEN 0 ELSE claimed_quantity END,last_command_id=?16
     WHERE return_id=?10 AND ?12<>'requested' AND EXISTS(SELECT 1 FROM owned c JOIN facts s ON s.order_id=c.order_id WHERE ${projection} AND ${live} AND s.snapshot=c.source_snapshot)`,
    `${ownPrefix} INSERT INTO order_return_events(command_id,return_id,actor_id,actor_type,order_id,action,version,input,response,public_message,created_at)
     SELECT c.id,c.return_id,c.actor_id,c.actor_type,c.order_id,c.action,c.result_version,c.input,c.response,c.public_message,c.created_at FROM owned c JOIN facts s ON s.order_id=c.order_id
     WHERE ${projection} AND ${live} AND s.snapshot=c.source_snapshot`,
    `${ownPrefix} INSERT INTO order_return_guards(id,satisfied) SELECT ?16,0 WHERE NOT EXISTS(SELECT 1 FROM owned c JOIN facts s ON s.order_id=c.order_id
     WHERE ${projection} AND ${auditProof} AND ${live} AND s.history_confirmed=1 AND s.snapshot=c.source_snapshot AND s.order_version=c.result_order_version)`
  ]
  // SQLite/D1 executes this transaction all-or-nothing. The final guard owns
  // this private nonce; an older successful command cannot satisfy a new batch.
  const email = await prepareOrderReturnEnqueue(database, {
    returnId: id,
    commandId,
    requested: action === 'requested',
    now: now()
  })
  await database.batch([...sql.map((statement) => database.prepare(statement).bind(...params)), email])
  const completed = await replay(database, actor, key, hash, now)
  if (!completed) throw new Error('returns_completion_unconfirmed')
  return completed
}
export async function requestD1CustomerReturn(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOrderId: string,
  input: unknown,
  rawOptions: { idempotencyKey: string; now?: string }
): Promise<ReturnCommandReceipt> {
  database = guardedDatabase(database)
  const options = checked(commandOptions, rawOptions),
    now = freshClock(options.now),
    actor = await actorFor(database, rawClaims, 'customer', now),
    orderId = checked(returnOrderIdSchema, rawOrderId),
    cmd = checked(returnRequestInputSchema, input),
    hash = await sha256Hex(canonicalJson({ orderId, input: cmd, kind: 'request' }))
  const previous = await replay(database, actor, options.idempotencyKey, hash, now)
  if (previous) return previous
  const s = await source(database, actor, orderId, now)
  validateRequest(s, cmd)
  await authorize(database, actor, now)
  try {
    return await commit(database, actor, s, null, cmd, options.idempotencyKey, hash, now)
  } catch (failure) {
    if (!knownConstraint(failure)) throw failure
    await authorize(database, actor, now)
    const winner = await replay(database, actor, options.idempotencyKey, hash, now)
    if (winner) return winner
    validateRequest(await source(database, actor, orderId, now), cmd)
    throw new ReturnsError('conflict')
  }
}
export async function executeD1AdminReturnCommand(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawRef: string,
  input: unknown,
  rawOptions: { idempotencyKey: string; now?: string }
): Promise<ReturnCommandReceipt> {
  database = guardedDatabase(database)
  const options = checked(commandOptions, rawOptions),
    now = freshClock(options.now),
    actor = await actorFor(database, rawClaims, 'admin', now),
    ref = checked(returnPublicRefSchema, rawRef),
    cmd = checked(returnTransitionInputSchema, input),
    hash = await sha256Hex(canonicalJson({ publicRef: ref, input: cmd, kind: 'transition' }))
  const previous = await replay(database, actor, options.idempotencyKey, hash, now)
  if (previous) return previous
  const r = await record(database, actor, ref, now),
    s = await source(database, actor, r.order_id, now),
    lines = await returnLines(database, r)
  await authorize(database, actor, now)
  validateTransition(s, r, lines, cmd)
  try {
    return await commit(database, actor, s, r, cmd, options.idempotencyKey, hash, now)
  } catch (failure) {
    if (!knownConstraint(failure)) throw failure
    await authorize(database, actor, now)
    const winner = await replay(database, actor, options.idempotencyKey, hash, now)
    if (winner) return winner
    const latest = await record(database, actor, ref, now),
      latestSource = await source(database, actor, latest.order_id, now),
      latestLines = await returnLines(database, latest)
    await authorize(database, actor, now)
    validateTransition(latestSource, latest, latestLines, cmd)
    throw new ReturnsError('conflict')
  }
}
const disabled = {
  refunds: false as const,
  fiscal: false as const,
  carrier: false as const,
  attachments: false as const
}
function pagination(page: number, perPage: number, total: number) {
  return { page, perPage, total, pages: Math.ceil(total / perPage) }
}
async function detail(
  database: D1Database,
  actor: Actor,
  r: RecordView,
  s: Source,
  page: number,
  perPage: number,
  now: Clock
): Promise<AdminOrderReturn | CustomerOrderReturn> {
  const lines = await returnLines(database, r)
  const rows = (
    await database
      .prepare(
        `SELECT c.id,c.actor_id,c.actor_type,c.action,c.result_version,c.reason,c.input,c.public_message,c.created_at FROM order_return_commands c
    WHERE c.return_id=?1 AND ${auditProof} ORDER BY c.result_version DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(r.id, perPage, (page - 1) * perPage)
      .all()
  ).results
  await authorize(database, actor, now)
  const commands = checked(
    z
      .array(
        z
          .object({
            id: catalogPolicyUuidSchema,
            actor_id: catalogPolicyUuidSchema,
            actor_type: z.enum(['admin', 'customer']),
            action: returnStateSchema,
            result_version: positive,
            reason: z.string(),
            input: z.string(),
            public_message: z.string(),
            created_at: catalogPolicyInstantSchema
          })
          .strict()
      )
      .max(50),
    rows,
    'history_unconfirmed'
  )
  const admission = await database
      .prepare("SELECT input FROM order_return_commands WHERE return_id=?1 AND action='approved'")
      .bind(r.id)
      .first<{ input: string }>(),
    resolution = await database
      .prepare("SELECT input FROM order_return_commands WHERE return_id=?1 AND action='resolution_ready'")
      .bind(r.id)
      .first<{ input: string }>(),
    last = await database
      .prepare('SELECT public_message FROM order_return_commands WHERE id=?1')
      .bind(r.last_command_id)
      .first<{ public_message: string }>()
  await authorize(database, actor, now)
  if (!last || s.location_id === null || s.location_name === null) throw new ReturnsError('history_unconfirmed')
  const base = {
    source: 'cloudflare',
    id: r.id,
    publicRef: r.public_ref,
    orderId: r.order_id,
    state: r.state,
    version: r.version,
    orderVersion: s.order_version,
    reason: r.reason,
    publicMessage: last.public_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    eligibility: {
      status:
        r.state === 'requested' ? 'review_required' : r.state === 'rejected' ? 'rejected' : 'admitted_after_review',
      automaticallyEligible: false,
      policyVersion: null
    },
    warehouse: { id: s.location_id, name: s.location_name },
    lines,
    inventoryEffect: 'none',
    custody: 'non_sellable'
  }
  if (actor.customerId !== null)
    return checked(
      customerOrderReturnSchema,
      {
        ...base,
        timeline: {
          items: commands.map((c) => ({
            action: c.action,
            version: c.result_version,
            message: c.public_message,
            createdAt: c.created_at
          })),
          pagination: pagination(page, perPage, r.version)
        },
        capabilities: { returnsRead: true, ...disabled }
      },
      'history_unconfirmed'
    )
  const timeline = commands.map((c) => {
    const parsed =
      c.action === 'requested'
        ? checked(returnRequestInputSchema, JSON.parse(c.input), 'history_unconfirmed')
        : checked(returnTransitionInputSchema, JSON.parse(c.input), 'history_unconfirmed')
    return {
      commandId: c.id,
      actorId: c.actor_id,
      actorType: c.actor_type,
      action: c.action,
      version: c.result_version,
      reason: c.reason,
      evidence: 'evidence' in parsed ? parsed.evidence : null,
      message: c.public_message,
      lines: 'lines' in parsed ? parsed.lines : [],
      cost: 'cost' in parsed ? (parsed.cost ?? null) : null,
      createdAt: c.created_at
    }
  })
  const blocked = blockers(s),
    allowed = blocked.length
      ? []
      : allowedReturnActions(
          r.state,
          lines.every((line) => line.receivedQuantity === line.authorizedQuantity),
          lines.every((line) => line.inspectedQuantity === line.receivedQuantity)
        )
  const approvedInput = admission
      ? checked(returnTransitionInputSchema, JSON.parse(admission.input), 'history_unconfirmed')
      : null,
    readyInput = resolution
      ? checked(returnTransitionInputSchema, JSON.parse(resolution.input), 'history_unconfirmed')
      : null
  return checked(
    adminOrderReturnSchema,
    {
      ...base,
      readiness: { ready: blocked.length === 0, blockers: blocked },
      capabilities: { returnsRead: true, returnsTransitions: allowed.length > 0, allowedActions: allowed, ...disabled },
      decisionRef: approvedInput?.action === 'approved' ? approvedInput.decisionRef : null,
      resolution: readyInput?.action === 'resolution_ready' ? readyInput.resolution : null,
      timeline: { items: timeline, pagination: pagination(page, perPage, r.version) },
      evaluatedAt: now()
    },
    'history_unconfirmed'
  )
}
async function stable(database: D1Database, actor: Actor, s: Source, now: Clock) {
  const latest = await source(database, actor, s.order_id, now)
  await authorize(database, actor, now)
  if (latest.snapshot !== s.snapshot || latest.order_version !== s.order_version || latest.history_confirmed !== 1)
    throw new ReturnsError('version_conflict')
}
export async function readD1AdminReturn(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawRef: string,
  rawOptions: { page: number; perPage: number; now?: string }
): Promise<AdminOrderReturn> {
  database = guardedDatabase(database)
  const options = checked(paginationOptions, rawOptions),
    now = freshClock(options.now),
    actor = await actorFor(database, rawClaims, 'admin', now),
    ref = checked(returnPublicRefSchema, rawRef),
    r = await record(database, actor, ref, now),
    s = await source(database, actor, r.order_id, now)
  if (s.history_confirmed !== 1) throw new ReturnsError('history_unconfirmed')
  const dto = checked(
    adminOrderReturnSchema,
    await detail(database, actor, r, s, options.page, options.perPage, now),
    'history_unconfirmed'
  )
  await stable(database, actor, s, now)
  return dto
}
export async function readD1CustomerReturns(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOrderId: string,
  rawOptions: { page: number; perPage: number; now?: string }
): Promise<CustomerOrderReturns> {
  database = guardedDatabase(database)
  const options = checked(paginationOptions, rawOptions),
    now = freshClock(options.now),
    actor = await actorFor(database, rawClaims, 'customer', now),
    id = checked(returnOrderIdSchema, rawOrderId),
    s = await source(database, actor, id, now)
  if (s.history_confirmed !== 1) throw new ReturnsError('history_unconfirmed')
  const records = checked(
    z.array(recordSchema).max(50),
    (
      await database
        .prepare('SELECT * FROM order_returns WHERE order_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3')
        .bind(id, options.perPage, (options.page - 1) * options.perPage)
        .all()
    ).results,
    'history_unconfirmed'
  )
  const total = checked(
    z.object({ n: integer }).strict(),
    await database.prepare('SELECT count(*) AS n FROM order_returns WHERE order_id=?1').bind(id).first(),
    'history_unconfirmed'
  ).n
  const returns: CustomerOrderReturn[] = []
  for (const r of records)
    returns.push(
      checked(customerOrderReturnSchema, await detail(database, actor, r, s, 1, 25, now), 'history_unconfirmed')
    )
  const blocked = blockers(s),
    dto = checked(
      customerOrderReturnsSchema,
      {
        source: 'cloudflare',
        orderId: id,
        version: s.order_version,
        readiness: { ready: blocked.length === 0, blockers: blocked },
        eligibility: { status: 'review_required', automaticallyEligible: false, policyVersion: null },
        lines: s.lines.map((line) => ({ ...line, availableQuantity: line.purchasedQuantity - line.claimedQuantity })),
        returns,
        pagination: pagination(options.page, options.perPage, total),
        capabilities: {
          returnsRead: true,
          returnRequest: blocked.length === 0 && s.lines.some((line) => line.claimedQuantity < line.purchasedQuantity),
          guestVerification: false,
          ...disabled
        },
        inventoryEffect: 'none',
        custody: 'non_sellable',
        evaluatedAt: now()
      },
      'history_unconfirmed'
    )
  await stable(database, actor, s, now)
  return dto
}
export async function listD1AdminReturns(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawOptions: { page: number; perPage: number; q?: string; state?: string; now?: string }
): Promise<AdminReturnList> {
  database = guardedDatabase(database)
  const options = checked(
      paginationOptions.extend({ q: z.string().max(100).optional(), state: returnStateSchema.optional() }),
      rawOptions
    ),
    now = freshClock(options.now),
    actor = await actorFor(database, rawClaims, 'admin', now),
    q = options.q ?? '',
    state = options.state ?? null
  const predicate =
    "(?7='' OR instr(lower(r.public_ref),lower(?7))>0 OR instr(lower(r.order_id),lower(?7))>0 OR instr(lower(COALESCE(o.contact_name,'')),lower(?7))>0) AND (?8 IS NULL OR r.state=?8)"
  const params = [...actorParams(actor, now, null), q, state, options.perPage, (options.page - 1) * options.perPage]
  const results = await database.batch([
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT r.id,r.public_ref AS publicRef,r.order_id AS orderId,r.state,r.version,r.reason,o.contact_name AS customerName,
      (SELECT SUM(requested_quantity) FROM order_return_lines WHERE return_id=r.id) AS requestedQuantity,(SELECT SUM(received_quantity) FROM order_return_lines WHERE return_id=r.id) AS receivedQuantity,
      r.created_at AS createdAt,r.updated_at AS updatedAt FROM order_returns r JOIN orders o ON o.id=r.order_id JOIN actor WHERE ${predicate} ORDER BY r.updated_at DESC,r.id DESC LIMIT ?9 OFFSET ?10`
      )
      .bind(...params),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT count(*) AS n FROM order_returns r JOIN orders o ON o.id=r.order_id JOIN actor WHERE ${predicate}`
      )
      .bind(...params.slice(0, 8))
  ])
  await authorize(database, actor, now)
  const total = checked(
    z.array(z.object({ n: integer }).strict()).length(1),
    results[1]?.results,
    'history_unconfirmed'
  )[0]!.n
  return checked(
    adminReturnListSchema,
    {
      source: 'cloudflare',
      items: results[0]?.results,
      pagination: pagination(options.page, options.perPage, total),
      capabilities: { returnsRead: true, ...disabled },
      evaluatedAt: now()
    },
    'history_unconfirmed'
  )
}
