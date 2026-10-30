import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { canonicalPayloadHash } from '../catalog/cart'
import { sha256Hex } from '../catalog/inventory'
import { PaymentError } from '../catalog/payments'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

const uuid = z.string().uuid()
const inputSchema = z
  .object({
    quoteId: uuid,
    expectedVersion: z.number().int().safe().positive(),
    orderId: uuid,
    orderToken: z.string().regex(/^[a-f0-9]{64}$/i),
    commandId: uuid,
    expiresAt: catalogPolicyInstantSchema
  })
  .strict()
const redirectSchema = z
  .object({
    actionUrl: z.string().url(),
    method: z.literal('POST'),
    fields: z
      .object({
        Ds_MerchantParameters: z.string().min(1).max(16384),
        Ds_Signature: z.string().min(1).max(16384),
        Ds_SignatureVersion: z.literal('HMAC_SHA512_V2')
      })
      .strict()
  })
  .strict()
type Quote = {
  id: string
  version: number
  status: string
  orderId: string | null
  total: { grossCents: number } | null
  validUntil: string
}
type Redirect = z.infer<typeof redirectSchema>
export class PayGoldError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'not_payable' | 'conflict' | 'unavailable') {
    super(code)
  }
}
export interface PayGoldDependencies {
  database: D1Database
  readQuote: (claims: VerifiedSessionClaims | null, id: string) => Promise<Quote>
  verify: (input: { orderId: string; orderToken: string; now: string }) => Promise<boolean>
  start: (input: {
    orderId: string
    orderToken: string
    idempotencyKey: string
    now: string
  }) => Promise<{ paymentIntentId: string; redirect: Redirect }>
  provider: {
    create(input: {
      paymentIntentId: string
      amountCents: number
      expiresAt: string
      redirect: Redirect
      idempotencyKey: string
    }): Promise<{ url: string; expiresAt: string }>
  }
  providerOrigin: string
  now: () => string
}
export function providerUrl(url: string, origin: string): string {
  try {
    const expected = new URL(origin),
      actual = new URL(url)
    if (
      expected.protocol !== 'https:' ||
      expected.origin !== origin ||
      expected.username ||
      expected.password ||
      actual.origin !== origin ||
      actual.username ||
      actual.password ||
      actual.hash ||
      url.length > 2048
    )
      throw new Error()
    return actual.href
  } catch {
    throw new PayGoldError('unavailable')
  }
}
export const live = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id AND c.status='active'
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND i.session_version=s.session_version AND i.status='active'
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND s.revoked_at IS NULL AND s.created_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND s.expires_at>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND c.id=?5)`
const beforeStart = `EXISTS(SELECT 1 FROM sales_quotes q JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version
 JOIN sales_quote_conversions b ON b.quote_id=q.id AND b.customer_id=q.customer_id AND b.quote_version+1=q.current_version
 JOIN sales_quote_versions approved ON approved.quote_id=q.id AND approved.version=b.quote_version AND approved.status='approved'
 JOIN orders o ON o.id=?8 AND o.customer_id=q.customer_id AND o.cart_id=b.cart_id AND o.quote_id=b.checkout_quote_id
 JOIN checkout_attempts a ON a.id=o.attempt_id AND a.cart_id=o.cart_id AND a.command_key=b.checkout_key AND a.order_id=o.id
 JOIN inventory_reservations r ON r.id=o.reservation_id
 WHERE q.id=?6 AND q.customer_id=?5 AND q.current_version=?7 AND v.status='converted'
 AND json_extract(v.snapshot_json,'$.orderId')=o.id AND json_extract(v.snapshot_json,'$.total.grossCents')=o.total_gross_cents
 AND json_extract(approved.snapshot_json,'$.total.grossCents')=o.total_gross_cents
 AND json_extract(approved.snapshot_json,'$.approvedHash')=b.approved_hash AND json_extract(v.snapshot_json,'$.approvedHash')=b.approved_hash
 AND json_extract(v.snapshot_json,'$.definition.validUntil')>=?10 AND o.status='awaiting_payment' AND o.access_revoked_at IS NULL
 AND o.currency='EUR' AND o.total_gross_cents=?11 AND o.token_hash=?12
 AND o.created_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND o.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')),'-1 day')
 AND r.status='reserved' AND r.expires_at>=?10
 AND o.reservation_expires_at>=?10 AND ?10>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')))`
const payable = `EXISTS(SELECT 1 FROM sales_quotes q JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version
 JOIN sales_quote_conversions b ON b.quote_id=q.id AND b.customer_id=q.customer_id AND b.quote_version+1=q.current_version
 JOIN sales_quote_versions approved ON approved.quote_id=q.id AND approved.version=b.quote_version AND approved.status='approved'
 JOIN orders o ON o.id=?8 AND o.customer_id=q.customer_id AND o.cart_id=b.cart_id AND o.quote_id=b.checkout_quote_id
 JOIN checkout_attempts a ON a.id=o.attempt_id AND a.cart_id=o.cart_id AND a.command_key=b.checkout_key AND a.order_id=o.id
 JOIN inventory_reservations r ON r.id=o.reservation_id
 JOIN payment_intents p ON p.id=?9 AND p.order_id=o.id
 WHERE q.id=?6 AND q.customer_id=?5 AND q.current_version=?7 AND v.status='converted'
 AND json_extract(v.snapshot_json,'$.orderId')=o.id AND json_extract(v.snapshot_json,'$.total.grossCents')=o.total_gross_cents
 AND json_extract(approved.snapshot_json,'$.total.grossCents')=o.total_gross_cents
 AND json_extract(approved.snapshot_json,'$.approvedHash')=b.approved_hash AND json_extract(v.snapshot_json,'$.approvedHash')=b.approved_hash
 AND json_extract(v.snapshot_json,'$.definition.validUntil')>=?10 AND o.status='awaiting_payment' AND o.access_revoked_at IS NULL
 AND o.currency='EUR' AND o.total_gross_cents=?11 AND o.token_hash=?12
 AND o.created_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND o.created_at>strftime('%Y-%m-%dT%H:%M:%SZ',max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')),'-1 day')
 AND r.status='reserved' AND r.expires_at>=?10
 AND o.reservation_expires_at>=?10 AND p.status='redirect_ready' AND p.amount_gross_cents=?11 AND p.expires_at>=?10
 AND ?10>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')))`
export interface PayGoldReceipt {
  quoteId: string
  orderId: string
  paymentIntentId: string
  amountCents: number
  expiresAt: string
  url: string
}
const recoverySchema = z
  .object({ quoteId: uuid, orderId: uuid, orderToken: z.string().regex(/^[a-f0-9]{64}$/i) })
  .strict()
export async function recoverPayGoldAttempt(
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  deps: PayGoldDependencies
): Promise<{ quoteId: string; orderId: string; expectedVersion: number; commandId: string; expiresAt: string } | null> {
  const parsed = recoverySchema.safeParse(raw)
  if (!parsed.success) throw new PayGoldError('invalid_input')
  const input = parsed.data
  const now = deps.now()
  if (!catalogPolicyInstantSchema.safeParse(now).success) throw new PayGoldError('unavailable')
  const customer = await activeOrderCustomerId(deps.database, claims, now)
  if (!customer) throw new PayGoldError('unauthenticated')
  if (!(await deps.verify({ orderId: input.orderId, orderToken: input.orderToken, now })))
    throw new PaymentError('unauthorized', 'Order not found')
  const quote = await deps.readQuote(claims, input.quoteId)
  if (quote.orderId !== input.orderId || quote.id !== input.quoteId || quote.status !== 'converted' || !quote.total)
    throw new PayGoldError('not_payable')
  const attempt = await deps.database
    .prepare(
      'SELECT command_id,quote_version,expires_at FROM paygold_attempts WHERE customer_id=? AND quote_id=? AND order_id=?'
    )
    .bind(customer, input.quoteId, input.orderId)
    .first<{ command_id: string; quote_version: number; expires_at: string }>()
  const current = deps.now()
  if ((await activeOrderCustomerId(deps.database, claims, current)) !== customer)
    throw new PayGoldError('unauthenticated')
  if (!(await deps.verify({ orderId: input.orderId, orderToken: input.orderToken, now: current })))
    throw new PaymentError('unauthorized', 'Order not found')
  if (!attempt) return null
  if (
    !uuid.safeParse(attempt.command_id).success ||
    !catalogPolicyInstantSchema.safeParse(attempt.expires_at).success ||
    attempt.expires_at <= current ||
    attempt.quote_version !== quote.version
  )
    throw new PayGoldError('not_payable')
  const check = await deps.database
    .prepare(
      `SELECT CASE WHEN ${live} AND ${beforeStart} AND NOT EXISTS (
      SELECT 1 FROM order_payment_states WHERE order_id=?8 AND status IN ('paid','provider_authorised','stock_exception')
    ) THEN 1 ELSE 0 END AS ok`
    )
    .bind(
      claims!.sessionId,
      claims!.identityId,
      claims!.sessionVersion,
      current,
      customer,
      input.quoteId,
      attempt.quote_version,
      input.orderId,
      null,
      attempt.expires_at,
      quote.total.grossCents,
      await sha256Hex(input.orderToken)
    )
    .first<{ ok: number }>()
  if (!check || check.ok !== 1) throw new PayGoldError('not_payable')
  return {
    quoteId: input.quoteId,
    orderId: input.orderId,
    expectedVersion: attempt.quote_version,
    commandId: attempt.command_id,
    expiresAt: attempt.expires_at
  }
}
export async function issuePayGoldLink(
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  deps: PayGoldDependencies
): Promise<PayGoldReceipt> {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw new PayGoldError('invalid_input')
  const input = parsed.data,
    now = deps.now()
  if (!catalogPolicyInstantSchema.safeParse(now).success || input.expiresAt <= now)
    throw new PayGoldError('invalid_input')
  const customer = await activeOrderCustomerId(deps.database, claims, now)
  if (!customer) throw new PayGoldError('unauthenticated')
  if (!(await deps.verify({ orderId: input.orderId, orderToken: input.orderToken, now })))
    throw new PaymentError('unauthorized', 'Order not found')
  const tokenHash = await sha256Hex(input.orderToken)
  const quote = await deps.readQuote(claims, input.quoteId)
  if (
    quote.id !== input.quoteId ||
    quote.status !== 'converted' ||
    quote.version !== input.expectedVersion ||
    quote.orderId !== input.orderId ||
    !quote.total ||
    !Number.isSafeInteger(quote.total.grossCents) ||
    quote.total.grossCents <= 0 ||
    quote.validUntil < input.expiresAt
  )
    throw new PayGoldError('not_payable')
  const hash = await canonicalPayloadHash({
    kind: 'paygold-link-v1',
    quoteId: input.quoteId,
    expectedVersion: input.expectedVersion,
    orderId: input.orderId,
    expiresAt: input.expiresAt,
    customerId: customer
  })
  const existing = await deps.database
    .prepare('SELECT * FROM paygold_commands WHERE customer_id=? AND command_id=?')
    .bind(customer, input.commandId)
    .first<{
      payload_hash: string
      url: string
      payment_intent_id: string
      amount_cents: number
      expires_at: string
      order_id: string
    }>()
  if (existing && existing.payload_hash !== hash) throw new PayGoldError('conflict')
  const beforeArgs = [
    claims!.sessionId,
    claims!.identityId,
    claims!.sessionVersion,
    now,
    customer,
    input.quoteId,
    input.expectedVersion,
    input.orderId,
    null,
    input.expiresAt,
    quote.total.grossCents,
    tokenHash
  ]
  const ready = await deps.database
    .prepare(`SELECT CASE WHEN ${live} AND ${beforeStart} THEN 1 ELSE 0 END AS ok`)
    .bind(...beforeArgs)
    .first<{ ok: number }>()
  if (!ready || ready.ok !== 1) {
    if (existing && existing.order_id === input.orderId)
      await deps.start({
        orderId: input.orderId,
        orderToken: input.orderToken,
        idempotencyKey: `paygold:${input.commandId}`,
        now
      })
    throw new PayGoldError('not_payable')
  }
  const attempt = await deps.database
    .prepare('SELECT command_id,payload_hash FROM paygold_attempts WHERE order_id=?')
    .bind(input.orderId)
    .first<{ command_id: string; payload_hash: string }>()
  if (attempt && (attempt.command_id !== input.commandId || attempt.payload_hash !== hash))
    throw new PayGoldError('conflict')
  if (!attempt) {
    const guardId = crypto.randomUUID()
    try {
      await deps.database.batch([
        deps.database
          .prepare(
            `INSERT INTO paygold_attempts(customer_id,command_id,quote_id,quote_version,order_id,payload_hash,expires_at,created_at)
          SELECT ?5,?13,?6,?7,?8,?14,?10,?4 WHERE ${live} AND ${beforeStart}`
          )
          .bind(...beforeArgs, input.commandId, hash),
        deps.database
          .prepare(
            `INSERT INTO paygold_guards(id,valid) SELECT ?15,CASE WHEN ${live} AND ${beforeStart}
          AND EXISTS(SELECT 1 FROM paygold_attempts WHERE customer_id=?5 AND command_id=?13 AND order_id=?8 AND payload_hash=?14)
          THEN 1 ELSE 0 END`
          )
          .bind(...beforeArgs, input.commandId, hash, guardId),
        deps.database.prepare('DELETE FROM paygold_guards WHERE id=?').bind(guardId)
      ])
    } catch {
      const raced = await deps.database
        .prepare('SELECT customer_id,command_id,payload_hash FROM paygold_attempts WHERE order_id=?')
        .bind(input.orderId)
        .first<{ customer_id: string; command_id: string; payload_hash: string }>()
      if (
        !raced ||
        raced.customer_id !== customer ||
        raced.command_id !== input.commandId ||
        raced.payload_hash !== hash
      )
        throw new PayGoldError(raced ? 'conflict' : 'not_payable')
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
  if (!uuid.safeParse(started.paymentIntentId).success || !redirectSchema.safeParse(started.redirect).success)
    throw new PayGoldError('unavailable')
  if (existing && existing.payment_intent_id !== started.paymentIntentId) throw new PayGoldError('conflict')
  const args = [
    claims!.sessionId,
    claims!.identityId,
    claims!.sessionVersion,
    now,
    customer,
    input.quoteId,
    input.expectedVersion,
    input.orderId,
    started.paymentIntentId,
    input.expiresAt,
    quote.total.grossCents,
    tokenHash
  ]
  const check = async () => {
    const current = await activeOrderCustomerId(deps.database, claims, deps.now())
    if (current !== customer) throw new PayGoldError('unauthenticated')
    const valid = await deps.database
      .prepare(`SELECT CASE WHEN ${live} AND ${payable} THEN 1 ELSE 0 END AS ok`)
      .bind(...args)
      .first<{ ok: number }>()
    if (!valid || valid.ok !== 1) throw new PayGoldError('not_payable')
  }
  await check()
  const view = (url: string) => ({
    quoteId: input.quoteId,
    orderId: input.orderId,
    paymentIntentId: started.paymentIntentId,
    amountCents: quote.total!.grossCents,
    expiresAt: input.expiresAt,
    url
  })
  if (existing) {
    const proof = await deps.database
      .prepare(
        'SELECT 1 ok FROM paygold_audit WHERE customer_id=? AND command_id=? AND order_id=? AND quote_id=? AND payment_intent_id=? AND payload_hash=?'
      )
      .bind(customer, input.commandId, input.orderId, input.quoteId, started.paymentIntentId, hash)
      .first()
    if (!proof) throw new PayGoldError('unavailable')
    await check()
    return view(providerUrl(existing.url, deps.providerOrigin))
  }
  let generated: { url: string; expiresAt: string }
  try {
    generated = await deps.provider.create({
      paymentIntentId: started.paymentIntentId,
      amountCents: quote.total.grossCents,
      expiresAt: input.expiresAt,
      redirect: started.redirect,
      idempotencyKey: `paygold:${input.commandId}`
    })
  } catch {
    throw new PayGoldError('unavailable')
  }
  if (generated.expiresAt !== input.expiresAt) throw new PayGoldError('unavailable')
  const url = providerUrl(generated.url, deps.providerOrigin),
    guard = crypto.randomUUID()
  try {
    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO paygold_commands(customer_id,command_id,quote_id,quote_version,order_id,payment_intent_id,amount_cents,payload_hash,url,expires_at,created_at)
   SELECT ?5,?13,?6,?7,?8,?9,?11,?14,?15,?10,?4 WHERE ${live} AND ${payable}`
        )
        .bind(...args, input.commandId, hash, url),
      deps.database
        .prepare(
          `INSERT INTO paygold_audit(customer_id,command_id,order_id,quote_id,payment_intent_id,payload_hash,created_at)
   SELECT customer_id,command_id,order_id,quote_id,payment_intent_id,payload_hash,created_at FROM paygold_commands WHERE customer_id=? AND command_id=?`
        )
        .bind(customer, input.commandId),
      deps.database
        .prepare(
          `INSERT INTO paygold_guards(id,valid) SELECT ?13,CASE WHEN ${live} AND ${payable} AND EXISTS(SELECT 1 FROM paygold_audit WHERE customer_id=?5 AND command_id=?14 AND payload_hash=?15) THEN 1 ELSE 0 END`
        )
        .bind(...args, guard, input.commandId, hash),
      deps.database.prepare('DELETE FROM paygold_guards WHERE id=?').bind(guard)
    ])
  } catch {
    await check()
    const raced = await deps.database
      .prepare('SELECT payload_hash FROM paygold_commands WHERE customer_id=? AND command_id=?')
      .bind(customer, input.commandId)
      .first<{ payload_hash: string }>()
    if (raced && raced.payload_hash !== hash) throw new PayGoldError('conflict')
    if (raced) return issuePayGoldLink(claims, raw, deps)
    throw new PayGoldError('unavailable')
  }
  await check()
  return view(url)
}
