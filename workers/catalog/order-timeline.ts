import type { VerifiedSessionClaims } from './authorization'
import { authorizeFiscalOrder } from '../fiscal/access'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { validateOrderCancellationProof } from './order-cancellation'
import { validateRefundReceipt } from '../refunds/operations'
import { validateCreditReceipt } from '../fiscal/credit-notes'
import { hash, parsedJson } from '../refunds/authority'
import { refundContractSchema } from '../../shared/order-refunds'
import { creditContractSchema } from '../../shared/fiscal-credit'
import { fiscalContractSchema, fiscalReceiptSchema } from '../../shared/fiscal-issuance'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  orderTimelineAudienceSchema,
  orderTimelineItemSchema,
  orderTimelineResponseSchema,
  decodeOrderTimelineCursor,
  encodeOrderTimelineCursor,
  type OrderTimelineAudience,
  type OrderTimelineResponse
} from '../../shared/order-timeline'

export class OrderTimelineError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'read_unconfirmed'
  ) {
    super(code)
    this.name = 'OrderTimelineError'
  }
}
const auditColumns =
  'actor_id,order_id,location_id,action,input,expected_version,result_version,from_state,to_state,interrupted_state,reason,evidence,source_snapshot,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((column) => `a.${column} IS c.${column}`)
  .join(' AND ')
// Final linearization point: live session, MFA/grant and order ownership are
// evaluated in the SAME statement, after every other asynchronous read/proof.
const finalAuthoritySql = `WITH gate_clock AS MATERIALIZED (
  SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS now
) SELECT i.id,i.status AS identityStatus,
  (i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM gate_clock)) AS email_verified,
  s.mfa_verified,c.id AS customerId,o.id AS orderId,
  EXISTS(SELECT 1 FROM identity_roles role JOIN role_permissions permission ON permission.role_code=role.role_code
    WHERE role.identity_id=i.id AND permission.permission_code='administration.manage'
    AND role.granted_at<=(SELECT now FROM gate_clock) AND (role.expires_at IS NULL OR role.expires_at>(SELECT now FROM gate_clock))) AS permitted
  FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
  LEFT JOIN customers c ON c.id=i.customer_id AND c.status='active'
  LEFT JOIN orders o ON o.id=?5 AND (?6='admin' OR o.customer_id=c.id)
  WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
  AND i.status IN ('pending','active') AND s.revoked_at IS NULL
  AND s.created_at<=(SELECT now FROM gate_clock) AND s.expires_at>(SELECT now FROM gate_clock)`
export { finalAuthoritySql as orderTimelineAuthoritySql }
const sql = `WITH operational AS (
  SELECT 'checkout:'||e.id AS id,'checkout' AS kind,'created' AS state,e.created_at AS createdAt,NULL AS validationOnly,NULL AS proof
  FROM order_events e JOIN orders o ON o.id=e.order_id JOIN checkout_attempts attempt ON attempt.id=o.attempt_id
  WHERE o.id=?1 AND e.event_type='order.created' AND e.created_at=o.created_at
  AND attempt.order_id=o.id AND attempt.state='completed' AND attempt.cart_id=o.cart_id AND attempt.reservation_id=o.reservation_id
  AND EXISTS(SELECT 1 FROM checkout_commands c WHERE c.cart_id=o.cart_id AND c.kind='checkout' AND c.response_status=200
    AND c.payload_hash=attempt.payload_hash AND c.created_at=e.created_at AND c.correlation_id=e.correlation_id
    AND json_extract(c.response_body,'$.outcome')='order_created' AND json_extract(c.response_body,'$.body.id')=o.id)
  UNION ALL
  SELECT 'checkout:'||e.id,'checkout','cancelled',e.created_at,NULL,
    json_object('commandId',c.command_id,'payloadHash',c.payload_hash,'responseStatus',c.response_status,
      'responseBody',c.response_body,'correlationId',c.correlation_id,'createdAt',c.created_at,
      'audit',e.payload_json,'auditAt',e.created_at,'auditCorrelation',e.correlation_id)
  FROM order_events e JOIN payment_commands c ON c.order_id=e.order_id AND c.command_id=e.correlation_id
    AND e.id='order-cancelled:'||c.order_id||':'||c.command_id
  WHERE e.order_id=?1 AND e.event_type='order.cancelled'
  UNION ALL
  SELECT 'payment:'||e.id,'payment',e.event_type,e.created_at,NULL,NULL
  FROM payment_events e JOIN payment_intents p ON p.id=e.payment_intent_id AND p.order_id=e.order_id
  WHERE e.order_id=?1 AND (e.event_type<>'captured' OR
    EXISTS(SELECT 1 FROM payment_fulfilment_claims claim WHERE claim.order_id=e.order_id AND claim.payment_intent_id=p.id))
  UNION ALL
  SELECT 'fulfillment:'||c.id,'fulfillment',c.to_state,c.created_at,NULL,NULL FROM order_fulfillment_commands c
  WHERE c.order_id=?1 AND EXISTS(SELECT 1 FROM order_fulfillment_audit a WHERE a.command_id=c.id AND ${auditMatch})
  UNION ALL
  SELECT 'return:'||c.id,'return',c.to_state,c.created_at,NULL,NULL FROM order_return_commands c
  JOIN order_return_events e ON e.command_id=c.id AND e.return_id=c.return_id AND e.order_id=c.order_id
    AND e.actor_id=c.actor_id AND e.actor_type=c.actor_type AND e.action=c.action AND e.version=c.result_version
    AND e.input=c.input AND e.response=c.response AND e.public_message=c.public_message AND e.created_at=c.created_at
  WHERE c.order_id=?1
), financial AS (
  SELECT 'refund:'||e.id AS id,'refund' AS kind,'succeeded' AS state,e.created_at AS createdAt,c.validation_only AS validationOnly,
    json_object('entityId',c.id,'contract',c.contract_json,'fingerprint',c.contract_fingerprint,'receipt',r.receipt_json,'event',e.payload_json) AS proof
  FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id AND w.status='completed'
  JOIN refund_receipts r ON r.refund_id=c.id AND r.status='succeeded'
  JOIN refund_credit_obligations obligation ON obligation.refund_id=c.id
  JOIN order_events e ON e.id=obligation.source_event_id AND e.order_id=c.order_id AND e.correlation_id=c.id AND e.event_type='refund.succeeded'
  WHERE c.order_id=?1 AND (?5=1 OR c.validation_only=0) AND w.completed_at=e.created_at AND r.recorded_at=e.created_at
  UNION ALL
  SELECT 'fiscal:'||e.id,'fiscal',r.fiscal_status,e.created_at,c.validation_only,
    json_object('entityId',c.id,'contract',c.contract_json,'fingerprint',c.contract_fingerprint,'receipt',json_object('providerId',r.provider_invoice_id,'code',r.code,'status',r.fiscal_status,'amountCents',r.amount_gross_cents,'currency',r.currency),'event',e.payload_json)
  FROM fiscal_invoice_intents c JOIN fiscal_issuance_work w ON w.intent_id=c.id AND w.status='completed'
  JOIN fiscal_provider_receipts r ON r.intent_id=c.id AND r.provider=c.provider AND r.contract_fingerprint=c.contract_fingerprint
  JOIN fiscal_documents doc ON doc.intent_id=c.id AND doc.order_id=c.order_id
  JOIN order_events e ON e.order_id=c.order_id AND e.correlation_id=c.id AND e.event_type='invoice.issued'
  WHERE c.order_id=?1 AND (?5=1 OR c.validation_only=0) AND w.completed_at=e.created_at AND doc.created_at=e.created_at
    AND json_extract(e.payload_json,'$.documentKind') IS NULL
  UNION ALL
  SELECT 'credit:'||e.id,'credit',json_extract(r.receipt_json,'$.status'),e.created_at,c.validation_only,
    json_object('entityId',c.id,'contract',c.contract_json,'fingerprint',c.contract_fingerprint,'receipt',r.receipt_json,'event',e.payload_json)
  FROM fiscal_credit_contracts c JOIN fiscal_credit_work w ON w.credit_id=c.id AND w.status='completed'
  JOIN fiscal_credit_receipts r ON r.credit_id=c.id JOIN fiscal_credit_documents doc ON doc.credit_id=c.id
  JOIN order_events e ON e.order_id=c.order_id AND e.correlation_id=c.id AND e.event_type='invoice.issued'
  WHERE c.order_id=?1 AND (?5=1 OR c.validation_only=0) AND w.completed_at=e.created_at AND doc.created_at=e.created_at
    AND json_extract(e.payload_json,'$.documentKind')='credit_note'
), timeline_events AS (SELECT * FROM operational UNION ALL SELECT * FROM financial)
SELECT id,kind,state,createdAt,validationOnly,proof FROM timeline_events
WHERE createdAt<=?2 AND (?3 IS NULL OR createdAt<?3 OR (createdAt=?3 AND id<?4))
ORDER BY createdAt DESC,id DESC LIMIT ?6`

async function financialProof(row: Record<string, unknown>, orderId: string) {
  if (row.proof === null) return
  if (typeof row.proof !== 'string') throw new OrderTimelineError('read_unconfirmed')
  const proof = JSON.parse(row.proof) as Record<string, unknown>
  if (row.kind === 'checkout' && row.state === 'cancelled') {
    try {
      if (typeof proof.commandId !== 'string') throw new Error('invalid_cancellation_proof')
      await validateOrderCancellationProof(proof, orderId, proof.commandId)
    } catch {
      throw new OrderTimelineError('read_unconfirmed')
    }
    return
  }
  if (typeof proof.contract !== 'string' || typeof proof.fingerprint !== 'string' || typeof proof.event !== 'string')
    throw new OrderTimelineError('read_unconfirmed')
  const event = parsedJson(proof.event) as Record<string, unknown>
  if (row.kind === 'refund') {
    const contract = refundContractSchema.parse(parsedJson(proof.contract))
    if (
      contract.refundId !== proof.entityId ||
      contract.orderId !== orderId ||
      (await hash(contract)) !== proof.fingerprint
    )
      throw new OrderTimelineError('read_unconfirmed')
    const receipt = validateRefundReceipt(contract, proof.fingerprint, parsedJson(String(proof.receipt)))
    if (
      receipt.status !== 'succeeded' ||
      event.refundId !== contract.refundId ||
      event.returnId !== contract.returnId ||
      event.amountCents !== contract.amountCents ||
      event.validationOnly !== contract.validationOnly ||
      row.validationOnly !== Number(contract.validationOnly)
    )
      throw new OrderTimelineError('read_unconfirmed')
  } else if (row.kind === 'credit') {
    const contract = creditContractSchema.parse(parsedJson(proof.contract))
    if (
      contract.creditId !== proof.entityId ||
      contract.orderId !== orderId ||
      (await hash(contract)) !== proof.fingerprint ||
      (await hash(contract.sourceContract)) !== contract.sourceContractFingerprint
    )
      throw new OrderTimelineError('read_unconfirmed')
    const receipt = validateCreditReceipt(contract, proof.fingerprint, parsedJson(String(proof.receipt)))
    if (
      receipt.status !== row.state ||
      event.invoiceId !== contract.creditId ||
      event.refundId !== contract.refundId ||
      event.sourceInvoiceId !== contract.sourceInvoiceId ||
      event.documentKind !== 'credit_note' ||
      event.provider !== contract.provider ||
      event.code !== receipt.code ||
      event.validationOnly !== contract.validationOnly ||
      row.validationOnly !== Number(contract.validationOnly)
    )
      throw new OrderTimelineError('read_unconfirmed')
  } else if (row.kind === 'fiscal') {
    const contract = fiscalContractSchema.parse(parsedJson(proof.contract)),
      receipt = fiscalReceiptSchema.parse(proof.receipt)
    if (
      contract.orderId !== orderId ||
      (await hash(contract)) !== proof.fingerprint ||
      receipt.amountCents !== contract.totalGrossCents ||
      event.invoiceId !== proof.entityId ||
      event.provider !== contract.provider ||
      event.code !== receipt.code ||
      event.validationOnly !== contract.validationOnly ||
      row.validationOnly !== Number(contract.validationOnly)
    )
      throw new OrderTimelineError('read_unconfirmed')
  } else throw new OrderTimelineError('read_unconfirmed')
}
export async function readD1OrderTimeline(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: {
    audience: OrderTimelineAudience
    limit?: number
    cursor?: string
    now?: () => string
    appEnvironment: 'local' | 'preview' | 'production'
  }
): Promise<OrderTimelineResponse> {
  database = guardedFiscalDatabase(database)
  const limit = options.limit ?? 10
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    !orderTimelineAudienceSchema.safeParse(options.audience).success ||
    !['local', 'preview', 'production'].includes(options.appEnvironment)
  )
    throw new OrderTimelineError('invalid_input')
  const now = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')),
    instant = catalogPolicyInstantSchema.parse(now())
  let cursor: ReturnType<typeof decodeOrderTimelineCursor> | null = null
  if (options.cursor !== undefined) {
    try {
      cursor = decodeOrderTimelineCursor(options.cursor)
      if (cursor.orderId !== orderId || cursor.audience !== options.audience || cursor.asOf > instant)
        throw new Error('scope')
    } catch {
      throw new OrderTimelineError('invalid_input')
    }
  }
  async function authorize() {
    if (!claims) throw new OrderTimelineError('unauthenticated')
    try {
      await authorizeFiscalOrder(database, { kind: options.audience, claims }, orderId, now())
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : 'read_unconfirmed'
      if (['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden', 'not_found'].includes(String(code)))
        throw new OrderTimelineError(code as OrderTimelineError['code'])
      throw new OrderTimelineError('read_unconfirmed')
    }
  }
  await authorize()
  const asOf = cursor?.asOf ?? instant,
    result = await database
      .prepare(sql)
      .bind(
        orderId,
        asOf,
        cursor?.at ?? null,
        cursor?.id ?? null,
        options.appEnvironment === 'local' ? 1 : 0,
        limit + 1
      )
      .all()
  // Bounded cryptographic proof checks are pure: no per-event database reads.
  await Promise.all(result.results.map((row) => financialProof(row, orderId)))
  await authorize()
  const final = await database
    .prepare(finalAuthoritySql)
    .bind(
      options.now ? now() : null,
      claims!.sessionId,
      claims!.identityId,
      claims!.sessionVersion,
      orderId,
      options.audience
    )
    .first<{
      identityStatus: string
      email_verified: number
      mfa_verified: number
      customerId: string | null
      orderId: string | null
      permitted: number
    }>()
  if (!final) throw new OrderTimelineError('unauthenticated')
  if (options.audience === 'customer') {
    if (final.identityStatus !== 'active' || final.email_verified !== 1 || !final.customerId)
      throw new OrderTimelineError('unauthenticated')
  } else {
    if (final.email_verified !== 1) throw new OrderTimelineError('email_unverified')
    if (final.mfa_verified !== 1) throw new OrderTimelineError('mfa_required')
    if (final.permitted !== 1) throw new OrderTimelineError('forbidden')
  }
  if (final.orderId !== orderId) throw new OrderTimelineError('not_found')
  const items = result.results.slice(0, limit).map((row) =>
      orderTimelineItemSchema.parse({
        id: row.id,
        kind: row.kind,
        state: row.state,
        createdAt: row.createdAt,
        validationOnly: row.validationOnly === null ? null : row.validationOnly === 1
      })
    ),
    last = items.at(-1)
  return orderTimelineResponseSchema.parse({
    source: 'cloudflare',
    orderId,
    audience: options.audience,
    items,
    nextCursor:
      result.results.length > limit && last
        ? encodeOrderTimelineCursor({
            v: 1,
            orderId,
            audience: options.audience,
            asOf,
            at: String(last.createdAt),
            id: String(last.id)
          })
        : null
  })
}
