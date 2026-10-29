import { z } from 'zod'
import { canonicalPayloadHash } from './cart'
import { activeOrderCustomerId } from './customer-orders'
import type { VerifiedSessionClaims } from './authorization'
import { authorizeD1CompanyReview } from '../auth/admin-companies'

export class B2BCreditError extends Error {
  constructor(readonly code: 'invalid_input' | 'conflict' | 'unavailable' | 'unauthorized') {
    super(code)
  }
}
const creditInput = z
  .object({
    expectedVersion: z.number().int().safe().nonnegative(),
    paymentDays: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]),
    creditLimitCents: z.number().int().safe().nonnegative(),
    blocked: z.boolean(),
    blockReason: z.string().trim().min(1).max(500).nullable(),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()
  .refine((v) => v.blocked === (v.blockReason !== null))
type Options = { idempotencyKey: string; now?: () => string }
function clock(now?: () => string) {
  const value = now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || new Date(value).toISOString().replace('.000Z', 'Z') !== value)
    throw new B2BCreditError('invalid_input')
  return value
}
export async function upsertD1B2BCreditTerms(
  db: D1Database,
  claims: VerifiedSessionClaims,
  companyId: string,
  input: unknown,
  options: Options
) {
  const parsed = creditInput.safeParse(input)
  if (
    !parsed.success ||
    !z.string().uuid().safeParse(companyId).success ||
    !z.string().uuid().safeParse(options.idempotencyKey).success
  )
    throw new B2BCreditError('invalid_input')
  const now = clock(options.now),
    value = parsed.data
  await authorizeD1CompanyReview(db, claims, { now: () => now })
  const hash = await canonicalPayloadHash({ action: 'b2b_credit_terms', companyId, ...value })
  async function saved() {
    const row = await db
      .prepare(
        'SELECT company_id,payload_hash,expected_version FROM b2b_credit_commands WHERE actor_id=?1 AND command_id=?2'
      )
      .bind(claims.identityId, options.idempotencyKey)
      .first<{ company_id: string; payload_hash: string; expected_version: number }>()
    if (!row) return null
    if (row.company_id !== companyId || row.payload_hash !== hash) throw new B2BCreditError('conflict')
    return { companyId, commandId: options.idempotencyKey, version: row.expected_version + 1 }
  }
  const prior = await saved()
  if (prior) return prior
  try {
    await db
      .prepare(
        `INSERT INTO b2b_credit_commands(actor_id,command_id,session_id,session_version,company_id,expected_version,payment_days,credit_limit_cents,blocked,block_reason,reason,payload_hash,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
      )
      .bind(
        claims.identityId,
        options.idempotencyKey,
        claims.sessionId,
        claims.sessionVersion,
        companyId,
        value.expectedVersion,
        value.paymentDays,
        value.creditLimitCents,
        value.blocked ? 1 : 0,
        value.blockReason,
        value.reason,
        hash,
        now
      )
      .run()
  } catch (error) {
    await authorizeD1CompanyReview(db, claims, { now: () => now })
    const raced = await saved()
    if (raced) return raced
    if (
      error instanceof Error &&
      /b2b_credit_(version_conflict|company_not_approved|command_immutable)|constraint failed/i.test(error.message)
    )
      throw new B2BCreditError('conflict')
    throw new B2BCreditError('unavailable')
  }
  await authorizeD1CompanyReview(db, claims, { now: () => now })
  const result = await saved()
  if (!result) throw new B2BCreditError('unavailable')
  return result
}

export async function readD1B2BCustomerTerms(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options: { now?: () => string } = {}
) {
  const now = clock(options.now)
  const customerId = await activeOrderCustomerId(db, claims, now)
  if (!customerId) throw new B2BCreditError('unauthorized')
  const row = await db
    .prepare(
      `SELECT c.id companyId,c.status companyStatus,t.payment_days paymentDays,t.credit_limit_cents creditLimitCents,
    t.blocked,t.version, l.id priceListId,l.name priceListName,
    COALESCE((SELECT SUM(open.outstanding_cents) FROM b2b_credit_open_amounts open WHERE open.company_id=c.id
      AND (open.order_id IS NOT NULL OR (open.state IN('reserving','reserved') AND open.reservation_expires_at>?2))),0) exposureCents
    FROM companies c JOIN customers customer ON customer.id=c.customer_id AND customer.status='active'
    LEFT JOIN b2b_credit_terms t ON t.company_id=c.id
    LEFT JOIN b2b_company_assignments a ON a.company_id=c.id AND c.status='approved' AND a.active=1 AND a.valid_from<=?2 AND (a.valid_until IS NULL OR a.valid_until>?2)
    LEFT JOIN b2b_price_lists l ON l.id=a.price_list_id AND l.status='active' AND l.valid_from<=?2 AND (l.valid_until IS NULL OR l.valid_until>?2)
    WHERE c.customer_id=?1`
    )
    .bind(customerId, now)
    .first<{
      companyId: string
      companyStatus: string
      paymentDays: number | null
      creditLimitCents: number | null
      blocked: number | null
      version: number | null
      priceListId: string | null
      priceListName: string | null
      exposureCents: number
    }>()
  if ((await activeOrderCustomerId(db, claims, now)) !== customerId) throw new B2BCreditError('unauthorized')
  if (!row) return null
  return {
    ...row,
    blocked: row.blocked === 1,
    availableCents:
      row.companyStatus === 'approved' && row.blocked === 0 && row.paymentDays !== 0
        ? Math.max(0, (row.creditLimitCents ?? 0) - row.exposureCents)
        : 0
  }
}
