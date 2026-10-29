import { z } from 'zod'
import { authorizeD1CompanyReview } from '../auth/admin-companies'
import { canonicalPayloadHash } from './cart'
import { B2BCreditError } from './b2b-credit'
import type { VerifiedSessionClaims } from './authorization'

interface Options {
  environment: string
  now?: () => string
}
interface CommandOptions extends Options {
  idempotencyKey: string
}
const commandSchema = z
  .object({
    expectedOutstandingCents: z.number().int().safe().positive(),
    amountCents: z.number().int().safe().positive(),
    bankReference: z.string().regex(/^FAKE-[A-Z0-9-]{1,100}$/),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()
  .refine((value) => value.amountCents <= value.expectedOutstandingCents)
function localOnly(environment: string) {
  if (environment !== 'local') throw new B2BCreditError('unavailable')
}
function now(options: Options) {
  const value = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const parsed = new Date(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace('.000Z', 'Z') !== value
  )
    throw new B2BCreditError('invalid_input')
  return value
}
export async function listD1B2BTransferSimulations(db: D1Database, claims: VerifiedSessionClaims, options: Options) {
  localOnly(options.environment)
  const instant = now(options)
  await authorizeD1CompanyReview(db, claims, { now: () => instant })
  const { results } = await db
    .prepare(
      `SELECT o.id AS orderId,c.id AS companyId,c.legal_name AS companyName,o.total_gross_cents AS totalCents,
 open.outstanding_cents AS outstandingCents,
 max(0,open.outstanding_cents-COALESCE((SELECT SUM(amount_cents) FROM b2b_transfer_simulations WHERE order_id=o.id),0)) AS simulatedOutstandingCents,
 json_extract(event.payload_json,'$.paymentDueAt') AS paymentDueAt
 FROM b2b_credit_open_amounts open JOIN orders o ON o.id=open.order_id
 JOIN b2b_credit_reservations r ON r.attempt_id=open.attempt_id JOIN companies c ON c.id=r.company_id
 LEFT JOIN order_events event ON event.order_id=o.id AND event.event_type='order.created'
 WHERE o.status<>'cancelled' AND open.outstanding_cents>0 ORDER BY o.created_at,o.id LIMIT 200`
    )
    .all<{
      orderId: string
      companyId: string
      companyName: string
      totalCents: number
      outstandingCents: number
      simulatedOutstandingCents: number
      paymentDueAt: string | null
    }>()
  await authorizeD1CompanyReview(db, claims, { now: () => instant })
  return results
}
export async function reconcileD1B2BTransfer(
  db: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string,
  input: unknown,
  options: CommandOptions
) {
  localOnly(options.environment)
  const value = commandSchema.safeParse(input)
  if (
    !value.success ||
    !z.string().uuid().safeParse(orderId).success ||
    !z.string().uuid().safeParse(options.idempotencyKey).success
  )
    throw new B2BCreditError('invalid_input')
  const instant = now(options)
  await authorizeD1CompanyReview(db, claims, { now: () => instant })
  const fingerprint = await canonicalPayloadHash({ action: 'simulate_transfer', orderId, ...value.data })
  async function saved() {
    const row = await db
      .prepare(
        'SELECT order_id,payload_hash,expected_outstanding_cents,amount_cents FROM b2b_transfer_simulations WHERE actor_id=?1 AND command_id=?2'
      )
      .bind(claims.identityId, options.idempotencyKey)
      .first<{ order_id: string; payload_hash: string; expected_outstanding_cents: number; amount_cents: number }>()
    if (!row) return null
    if (row.order_id !== orderId || row.payload_hash !== fingerprint) throw new B2BCreditError('conflict')
    return {
      orderId,
      commandId: options.idempotencyKey,
      validationOnly: true,
      simulatedOutstandingCents: row.expected_outstanding_cents - row.amount_cents
    }
  }
  const prior = await saved()
  if (prior) return prior
  try {
    // FAKE-* is a deterministic local adapter. It cannot call any bank or Beply.
    await db
      .prepare(
        `INSERT INTO b2b_transfer_simulations(actor_id,command_id,session_id,session_version,order_id,expected_outstanding_cents,amount_cents,bank_reference,reason,payload_hash,created_at)
   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      )
      .bind(
        claims.identityId,
        options.idempotencyKey,
        claims.sessionId,
        claims.sessionVersion,
        orderId,
        value.data.expectedOutstandingCents,
        value.data.amountCents,
        value.data.bankReference,
        value.data.reason,
        fingerprint,
        instant
      )
      .run()
  } catch (error) {
    await authorizeD1CompanyReview(db, claims, { now: () => instant })
    const raced = await saved()
    if (raced) return raced
    if (error instanceof Error && /b2b_transfer_conflict|constraint failed/i.test(error.message))
      throw new B2BCreditError('conflict')
    throw new B2BCreditError('unavailable')
  }
  await authorizeD1CompanyReview(db, claims, { now: () => instant })
  const receipt = await saved()
  if (!receipt) throw new B2BCreditError('unavailable')
  return receipt
}
