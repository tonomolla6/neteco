/** PAY-020 (assisted sale): an expirable PayGold link bound to a converted draft order and its exact amount.
 *
 * The draft's own claim (`converted_order_id`, `total_cents`) is never trusted alone: it must match the
 * canonical order of the same customer, whose amount is what the shopper is charged. The payment itself is
 * the ordinary checkout intent, so the signed notification and reconciliation are identical to checkout.
 */
import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { sha256Hex } from '../catalog/inventory'
import { PaymentError } from '../catalog/payments'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { live, PayGoldError, providerUrl, type PayGoldDependencies } from './paygold-links'

const uuid = z.string().uuid()
export const draftLinkInputSchema = z
  .object({
    draftId: uuid,
    expectedVersion: z.number().int().safe().positive(),
    orderId: uuid,
    commandId: uuid,
    expiresAt: catalogPolicyInstantSchema
  })
  .strict()
export interface DraftPayGoldReceipt {
  draftId: string
  orderId: string
  paymentIntentId: string
  amountCents: number
  expiresAt: string
  url: string
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')"
// ?4 now, ?5 customer, ?6 draft, ?7 version, ?8 order, ?9 intent (NULL before start), ?10 expiry, ?11 amount, ?12 order token hash
const bound = `EXISTS(SELECT 1 FROM draft_orders d JOIN orders o ON o.id=d.converted_order_id AND o.customer_id=d.customer_id
 JOIN inventory_reservations r ON r.id=o.reservation_id
 WHERE d.id=?6 AND d.customer_id=?5 AND d.version=?7 AND d.status='converted' AND d.converted_order_id=?8
 AND d.currency='EUR' AND d.total_cents=o.total_gross_cents AND o.total_gross_cents=?11 AND o.id=?8
 AND o.status='awaiting_payment' AND o.access_revoked_at IS NULL AND o.currency='EUR' AND o.token_hash=?12
 AND o.created_at<=max(?4,${NOW}) AND o.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',max(?4,${NOW}),'-1 day')
 AND r.status='reserved' AND r.expires_at>=?10 AND o.reservation_expires_at>=?10 AND ?10>max(?4,${NOW})
 AND NOT EXISTS(SELECT 1 FROM order_payment_states WHERE order_id=o.id AND status IN ('paid','provider_authorised','stock_exception'))
 AND NOT EXISTS(SELECT 1 FROM payment_preauths WHERE order_id=o.id AND status IN ('requested','authorized','capture_pending','cancel_pending','captured','stock_exception')))`
const payable = `${bound} AND EXISTS(SELECT 1 FROM payment_intents p WHERE p.id=?9 AND p.order_id=?8 AND p.status='redirect_ready'
 AND p.amount_gross_cents=?11 AND p.expires_at>=?10)`

export async function issueDraftPayGoldLink(
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  deps: PayGoldDependencies
): Promise<DraftPayGoldReceipt> {
  const parsed = draftLinkInputSchema
    .extend({ orderToken: z.string().regex(/^[a-f0-9]{64}$/i) })
    .strict()
    .safeParse(raw)
  if (!parsed.success) throw new PayGoldError('invalid_input')
  const input = parsed.data
  const now = deps.now()
  if (!catalogPolicyInstantSchema.safeParse(now).success || input.expiresAt <= now)
    throw new PayGoldError('invalid_input')
  const customer = await activeOrderCustomerId(deps.database, claims, now)
  if (!customer) throw new PayGoldError('unauthenticated')
  if (!(await deps.verify({ orderId: input.orderId, orderToken: input.orderToken, now })))
    throw new PaymentError('unauthorized', 'Order not found')
  const tokenHash = await sha256Hex(input.orderToken)
  // The charged amount is always the canonical order's, read here; the draft must agree with it.
  const order = await deps.database
    .prepare('SELECT total_gross_cents AS total FROM orders WHERE id=? AND customer_id=?')
    .bind(input.orderId, customer)
    .first<{ total: number }>()
  if (!order || !Number.isSafeInteger(order.total) || order.total <= 0) throw new PayGoldError('not_payable')
  const key = `draft:${input.draftId}`
  const hash = await canonicalPayloadHash({
    kind: 'paygold-draft-link-v1',
    draftId: input.draftId,
    expectedVersion: input.expectedVersion,
    orderId: input.orderId,
    expiresAt: input.expiresAt,
    customerId: customer
  })
  const command = await deps.database
    .prepare(
      'SELECT payload_hash,url,payment_intent_id,order_id FROM paygold_commands WHERE customer_id=? AND command_id=?'
    )
    .bind(customer, input.commandId)
    .first<{ payload_hash: string; url: string; payment_intent_id: string; order_id: string }>()
  if (command && command.payload_hash !== hash) throw new PayGoldError('conflict')
  const args = (intent: string | null) => [
    claims!.sessionId,
    claims!.identityId,
    claims!.sessionVersion,
    now,
    customer,
    input.draftId,
    input.expectedVersion,
    input.orderId,
    intent,
    input.expiresAt,
    order.total,
    tokenHash
  ]
  const ready = await deps.database
    .prepare(`SELECT CASE WHEN ${live} AND ${bound} THEN 1 ELSE 0 END AS ok`)
    .bind(...args(null))
    .first<{ ok: number }>()
  if (!ready || ready.ok !== 1) throw new PayGoldError('not_payable')
  const attempt = await deps.database
    .prepare('SELECT command_id,payload_hash FROM paygold_attempts WHERE order_id=?')
    .bind(input.orderId)
    .first<{ command_id: string; payload_hash: string }>()
  if (attempt && (attempt.command_id !== input.commandId || attempt.payload_hash !== hash))
    throw new PayGoldError('conflict')
  if (!attempt) {
    const guard = crypto.randomUUID()
    try {
      await deps.database.batch([
        deps.database
          .prepare(
            `INSERT INTO paygold_attempts(customer_id,command_id,quote_id,quote_version,order_id,payload_hash,expires_at,created_at)
             SELECT ?5,?13,?15,?7,?8,?14,?10,?4 WHERE ${live} AND ${bound}`
          )
          .bind(...args(null), input.commandId, hash, key),
        deps.database
          .prepare(
            `INSERT INTO paygold_guards(id,valid) SELECT ?16,CASE WHEN ${live} AND ${bound}
             AND EXISTS(SELECT 1 FROM paygold_attempts WHERE customer_id=?5 AND command_id=?13 AND order_id=?8 AND payload_hash=?14) THEN 1 ELSE 0 END`
          )
          .bind(...args(null), input.commandId, hash, key, guard),
        deps.database.prepare('DELETE FROM paygold_guards WHERE id=?').bind(guard)
      ])
    } catch {
      const raced = await deps.database
        .prepare('SELECT customer_id,command_id,payload_hash FROM paygold_attempts WHERE order_id=?')
        .bind(input.orderId)
        .first<{ customer_id: string; command_id: string; payload_hash: string }>()
      if (!raced) throw new PayGoldError('not_payable')
      if (raced.customer_id !== customer || raced.command_id !== input.commandId || raced.payload_hash !== hash)
        throw new PayGoldError('conflict')
    }
  }
  if ((await activeOrderCustomerId(deps.database, claims, deps.now())) !== customer)
    throw new PayGoldError('unauthenticated')
  const started = await deps.start({
    orderId: input.orderId,
    orderToken: input.orderToken,
    idempotencyKey: `paygold:${input.commandId}`,
    now
  })
  if (!uuid.safeParse(started.paymentIntentId).success) throw new PayGoldError('unavailable')
  if (command && command.payment_intent_id !== started.paymentIntentId) throw new PayGoldError('conflict')
  const check = async () => {
    if ((await activeOrderCustomerId(deps.database, claims, deps.now())) !== customer)
      throw new PayGoldError('unauthenticated')
    const valid = await deps.database
      .prepare(`SELECT CASE WHEN ${live} AND ${payable} THEN 1 ELSE 0 END AS ok`)
      .bind(...args(started.paymentIntentId))
      .first<{ ok: number }>()
    if (!valid || valid.ok !== 1) throw new PayGoldError('not_payable')
  }
  await check()
  const view = (url: string): DraftPayGoldReceipt => ({
    draftId: input.draftId,
    orderId: input.orderId,
    paymentIntentId: started.paymentIntentId,
    amountCents: order.total,
    expiresAt: input.expiresAt,
    url
  })
  if (command) {
    const proof = await deps.database
      .prepare(
        'SELECT 1 ok FROM paygold_audit WHERE customer_id=? AND command_id=? AND order_id=? AND quote_id=? AND payment_intent_id=? AND payload_hash=?'
      )
      .bind(customer, input.commandId, input.orderId, key, started.paymentIntentId, hash)
      .first()
    if (!proof) throw new PayGoldError('unavailable')
    return view(providerUrl(command.url, deps.providerOrigin))
  }
  let generated: { url: string; expiresAt: string }
  try {
    generated = await deps.provider.create({
      paymentIntentId: started.paymentIntentId,
      amountCents: order.total,
      expiresAt: input.expiresAt,
      redirect: started.redirect,
      idempotencyKey: `paygold:${input.commandId}`
    })
  } catch {
    throw new PayGoldError('unavailable')
  }
  if (generated.expiresAt !== input.expiresAt) throw new PayGoldError('unavailable')
  const url = providerUrl(generated.url, deps.providerOrigin)
  const guard = crypto.randomUUID()
  try {
    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO paygold_commands(customer_id,command_id,quote_id,quote_version,order_id,payment_intent_id,amount_cents,payload_hash,url,expires_at,created_at)
           SELECT ?5,?13,?16,?7,?8,?9,?11,?14,?15,?10,?4 WHERE ${live} AND ${payable}`
        )
        .bind(...args(started.paymentIntentId), input.commandId, hash, url, key),
      deps.database
        .prepare(
          `INSERT INTO paygold_audit(customer_id,command_id,order_id,quote_id,payment_intent_id,payload_hash,created_at)
           SELECT customer_id,command_id,order_id,quote_id,payment_intent_id,payload_hash,created_at FROM paygold_commands WHERE customer_id=? AND command_id=?`
        )
        .bind(customer, input.commandId),
      deps.database
        .prepare(
          `INSERT INTO paygold_guards(id,valid) SELECT ?13,CASE WHEN ${live} AND ${payable}
           AND EXISTS(SELECT 1 FROM paygold_audit WHERE customer_id=?5 AND command_id=?14 AND payload_hash=?15) THEN 1 ELSE 0 END`
        )
        .bind(...args(started.paymentIntentId), guard, input.commandId, hash),
      deps.database.prepare('DELETE FROM paygold_guards WHERE id=?').bind(guard)
    ])
  } catch {
    await check()
    const raced = await deps.database
      .prepare('SELECT payload_hash,url FROM paygold_commands WHERE customer_id=? AND command_id=?')
      .bind(customer, input.commandId)
      .first<{ payload_hash: string; url: string }>()
    if (raced && raced.payload_hash !== hash) throw new PayGoldError('conflict')
    if (raced) return view(providerUrl(raced.url, deps.providerOrigin))
    throw new PayGoldError('unavailable')
  }
  await check()
  return view(url)
}
