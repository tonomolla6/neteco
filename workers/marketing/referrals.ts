import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { PromoFraudError, assessPromoFraud } from '../security/promo-fraud'
import {
  type CustomerReferralOverview,
  type ReferralAttributionView,
  type ReferralPolicy,
  calculateReturnWindowEndsAt,
  evaluateReferralFraud,
  generateReferralCode,
  referralAttributeOrderSchema,
  referralIntentHash,
  referralPolicyUpdateSchema
} from '../../shared/referrals'

export class ReferralError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'self_referral'
      | 'fraud_detected'
      | 'program_inactive'
      | 'window_not_elapsed'
      | 'security_configuration_missing'
  ) {
    super(code)
    this.name = 'ReferralError'
  }
}

function fail(code: ReferralError['code']): never {
  throw new ReferralError(code)
}

function resolveNow(now?: string | (() => string)): string {
  if (typeof now === 'function') return now()
  if (now) return now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function readD1ReferralPolicy(db: D1Database): Promise<ReferralPolicy> {
  const row = await db
    .prepare(
      `SELECT
        id, version, is_active, terms_version, reward_cents,
        referee_discount_cents, min_order_cents, return_window_days,
        max_referrals_per_advocate, updated_at, updated_by
      FROM referral_policies
      WHERE id = 'global'`
    )
    .first<{
      id: 'global'
      version: number
      is_active: number
      terms_version: string
      reward_cents: number
      referee_discount_cents: number
      min_order_cents: number
      return_window_days: number
      max_referrals_per_advocate: number
      updated_at: string
      updated_by: string
    }>()

  if (!row) {
    return {
      id: 'global',
      version: 1,
      isActive: true,
      termsVersion: 'terms-2026-v1',
      rewardCents: 1500,
      refereeDiscountCents: 1000,
      minOrderCents: 5000,
      returnWindowDays: 14,
      maxReferralsPerAdvocate: 10,
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: 'system'
    }
  }

  return {
    id: 'global',
    version: row.version,
    isActive: row.is_active === 1,
    termsVersion: row.terms_version,
    rewardCents: row.reward_cents,
    refereeDiscountCents: row.referee_discount_cents,
    minOrderCents: row.min_order_cents,
    returnWindowDays: row.return_window_days,
    maxReferralsPerAdvocate: row.max_referrals_per_advocate,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

export async function updateD1ReferralPolicy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    expectedVersion: number
    isActive?: boolean
    termsVersion?: string
    rewardCents?: number
    refereeDiscountCents?: number
    minOrderCents?: number
    returnWindowDays?: number
    maxReferralsPerAdvocate?: number
    now?: string
  }
): Promise<ReferralPolicy> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = referralPolicyUpdateSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const existing = await readD1ReferralPolicy(db)
  if (existing.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = existing.version + 1
  const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.isActive ? 1 : 0
  const termsVersion = input.termsVersion ?? existing.termsVersion
  const rewardCents = input.rewardCents ?? existing.rewardCents
  const refereeDiscountCents = input.refereeDiscountCents ?? existing.refereeDiscountCents
  const minOrderCents = input.minOrderCents ?? existing.minOrderCents
  const returnWindowDays = input.returnWindowDays ?? existing.returnWindowDays
  const maxReferralsPerAdvocate = input.maxReferralsPerAdvocate ?? existing.maxReferralsPerAdvocate

  const payloadHash = await referralIntentHash({
    action: 'update_policy',
    expectedVersion: input.expectedVersion,
    input
  })

  const updatedPolicy: ReferralPolicy = {
    id: 'global',
    version: nextVersion,
    isActive: isActive === 1,
    termsVersion,
    rewardCents,
    refereeDiscountCents,
    minOrderCents,
    returnWindowDays,
    maxReferralsPerAdvocate,
    updatedAt: now,
    updatedBy: claims.identityId
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE referral_policies SET
          is_active = ?, terms_version = ?, reward_cents = ?,
          referee_discount_cents = ?, min_order_cents = ?, return_window_days = ?,
          max_referrals_per_advocate = ?, version = ?, updated_at = ?, updated_by = ?
        WHERE id = 'global' AND version = ?`
      )
      .bind(
        isActive,
        termsVersion,
        rewardCents,
        refereeDiscountCents,
        minOrderCents,
        returnWindowDays,
        maxReferralsPerAdvocate,
        nextVersion,
        now,
        claims.identityId,
        input.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO referral_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'update_policy', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(updatedPolicy),
        now
      )
  ]

  await db.batch(statements)
  return updatedPolicy
}

export async function enrollD1ReferralAdvocate(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    termsVersion: string
    consentedAt?: string
    now?: string
  }
): Promise<{ customerId: string; referralCode: string; termsVersion: string; status: string }> {
  const now = resolveNow(input.now ?? input.consentedAt)
  if (!claims?.identityId) fail('unauthenticated')

  // Lookup customer for identity
  const identity = await db
    .prepare(`SELECT customer_id FROM identities WHERE id = ?`)
    .bind(claims.identityId)
    .first<{ customer_id: string }>()

  const customerId = identity?.customer_id || claims.identityId

  // Check if already enrolled
  const existing = await db
    .prepare(
      `SELECT customer_id, referral_code, terms_version, status FROM referral_advocate_enrollments WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<{ customer_id: string; referral_code: string; terms_version: string; status: string }>()

  if (existing) {
    return {
      customerId: existing.customer_id,
      referralCode: existing.referral_code,
      termsVersion: existing.terms_version,
      status: existing.status
    }
  }

  const referralCode = generateReferralCode(customerId)

  await db
    .prepare(
      `INSERT INTO referral_advocate_enrollments (
        customer_id, referral_code, terms_version, consented_at, status, version, created_at
      ) VALUES (?, ?, ?, ?, 'active', 1, ?)`
    )
    .bind(customerId, referralCode, input.termsVersion, now, now)
    .run()

  return {
    customerId,
    referralCode,
    termsVersion: input.termsVersion,
    status: 'active'
  }
}

export async function attributeD1ReferralOrder(
  db: D1Database,
  input: {
    commandId: string
    idempotencyKey: string
    referralCode: string
    refereeCustomerId: string
    orderId: string
    now?: string
  },
  /** SEC-036: when present every attribution is assessed (fail closed) before it can ever be paid. */
  options: { fraudPepper?: string } = {}
): Promise<ReferralAttributionView> {
  const now = resolveNow(input.now)
  const parsed = referralAttributeOrderSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  if ('fraudPepper' in options && (typeof options.fraudPepper !== 'string' || options.fraudPepper.length < 32))
    fail('security_configuration_missing')

  // Find advocate by referral code
  const enrollment = await db
    .prepare(`SELECT customer_id, status FROM referral_advocate_enrollments WHERE referral_code = ?`)
    .bind(input.referralCode)
    .first<{ customer_id: string; status: string }>()

  if (!enrollment || enrollment.status !== 'active') {
    fail('not_found')
  }

  const advocateCustomerId = enrollment.customer_id

  // Fetch policy
  const policy = await readD1ReferralPolicy(db)
  if (!policy.isActive) fail('program_inactive')

  // Fetch order
  const order = await db
    .prepare(
      `SELECT id, customer_id, total_gross_cents, status, created_at, updated_at
       FROM orders WHERE id = ?`
    )
    .bind(input.orderId)
    .first<{
      id: string
      customer_id: string
      total_gross_cents: number
      status: string
      created_at: string
      updated_at: string
    }>()

  if (!order) fail('not_found')
  // The caller (session code) vouches for the referee; the order must really be theirs.
  if (order.customer_id !== input.refereeCustomerId) fail('not_found')

  // Fetch customer emails
  const advocate = await db
    .prepare(`SELECT i.email FROM customers c LEFT JOIN identities i ON i.customer_id = c.id WHERE c.id = ?`)
    .bind(advocateCustomerId)
    .first<{ email: string }>()

  const referee = await db
    .prepare(`SELECT i.email FROM customers c LEFT JOIN identities i ON i.customer_id = c.id WHERE c.id = ?`)
    .bind(input.refereeCustomerId)
    .first<{ email: string }>()

  // Prior completed orders count for referee
  const priorOrders = await db
    .prepare(
      `SELECT count(*) as count FROM orders WHERE customer_id = ? AND id <> ? AND status IN ('completed', 'fulfilled')`
    )
    .bind(input.refereeCustomerId, input.orderId)
    .first<{ count: number }>()

  // Active referrals count for advocate
  const activeReferrals = await db
    .prepare(
      `SELECT count(*) as count FROM referral_attributions
       WHERE advocate_customer_id = ? AND status IN ('pending_window', 'rewarded')`
    )
    .bind(advocateCustomerId)
    .first<{ count: number }>()

  const fraudEvaluation = evaluateReferralFraud({
    advocateCustomerId,
    refereeCustomerId: input.refereeCustomerId,
    advocateEmailHash: advocate?.email ?? 'hash-a',
    refereeEmailHash: referee?.email ?? 'hash-b',
    priorOrdersCount: priorOrders?.count ?? 0,
    activeAdvocateReferralsCount: activeReferrals?.count ?? 0,
    maxReferralsAllowed: policy.maxReferralsPerAdvocate
  })

  const completedAt = order.updated_at || order.created_at || now
  const returnWindowEndsAt = calculateReturnWindowEndsAt(completedAt, policy.returnWindowDays)

  const attributionId = input.commandId
  const status = fraudEvaluation.passed ? 'pending_window' : 'rejected'
  const rejectionReason = fraudEvaluation.passed ? null : fraudEvaluation.reasons.join(', ')

  const payloadHash = await referralIntentHash({
    action: 'attribute_referral',
    referralCode: input.referralCode,
    refereeCustomerId: input.refereeCustomerId,
    orderId: input.orderId
  })

  const attributionRecord: ReferralAttributionView = {
    id: attributionId,
    referralCode: input.referralCode,
    advocateCustomerId,
    refereeCustomerId: input.refereeCustomerId,
    orderId: input.orderId,
    orderAmountCents: order.total_gross_cents,
    orderCompletedAt: completedAt,
    returnWindowEndsAt,
    status,
    rejectionReason,
    fraudCheckPassed: fraudEvaluation.passed,
    fraudReasons: fraudEvaluation.reasons,
    rewardCents: fraudEvaluation.passed ? policy.rewardCents : 0,
    rewardIssuedAt: null,
    createdAt: now
  }

  if (options.fraudPepper) {
    const address = await db
      .prepare(`SELECT line1, line2, postal_code, city FROM order_shipping_address WHERE order_id = ?`)
      .bind(input.orderId)
      .first<{ line1: string; line2: string | null; postal_code: string; city: string }>()
    const signals: { identity?: string; address?: string } = {}
    if (referee?.email) signals.identity = referee.email
    if (address)
      signals.address = [address.line1, address.line2, address.postal_code, address.city].filter(Boolean).join(', ')
    // Server-derived signals only; before the attribution exists, replay-safe through the command id.
    if (Object.keys(signals).length) {
      try {
        await assessPromoFraud(
          db,
          {
            commandId: input.commandId,
            context: 'referral',
            refId: attributionId,
            customerId: input.refereeCustomerId,
            signals
          },
          { now, pepper: options.fraudPepper }
        )
      } catch (error) {
        if (error instanceof PromoFraudError) {
          if (error.code === 'customer_not_found') fail('not_found')
          if (error.code === 'already_assessed' || error.code === 'idempotency_conflict') fail('conflict')
          if (error.code === 'security_configuration_missing') fail('security_configuration_missing')
        }
        throw error
      }
    }
  }

  // Lookup actor identity for command journal
  const actor = await db
    .prepare(`SELECT id FROM identities WHERE customer_id = ? OR id = ? LIMIT 1`)
    .bind(advocateCustomerId, advocateCustomerId)
    .first<{ id: string }>()

  const actorId = actor?.id ?? advocateCustomerId

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO referral_attributions (
          id, referral_code, advocate_customer_id, referee_customer_id, order_id,
          order_amount_cents, order_completed_at, return_window_ends_at, status,
          rejection_reason, fraud_check_passed, fraud_reasons, reward_cents,
          reward_issued_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .bind(
        attributionId,
        input.referralCode,
        advocateCustomerId,
        input.refereeCustomerId,
        input.orderId,
        order.total_gross_cents,
        completedAt,
        returnWindowEndsAt,
        status,
        rejectionReason,
        fraudEvaluation.passed ? 1 : 0,
        JSON.stringify(fraudEvaluation.reasons),
        attributionRecord.rewardCents,
        now
      ),
    db
      .prepare(
        `INSERT INTO referral_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'attribute_referral', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        actorId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(attributionRecord),
        now
      )
  ]

  await db.batch(statements)
  return attributionRecord
}

export async function settleD1ReferralAttributions(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    now?: string
  }
): Promise<{ settledCount: number; settledRewardCentsTotal: number }> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  // One transaction, each statement guarded by the current status: concurrent settlements cannot pay twice,
  // an order returned/cancelled in the window is rejected instead of paid, and a SEC-036 hold withholds it.
  const unreturned = `NOT EXISTS(SELECT 1 FROM orders o WHERE o.id = referral_attributions.order_id AND o.status = 'cancelled')
        AND NOT EXISTS(SELECT 1 FROM order_returns r WHERE r.order_id = referral_attributions.order_id
          AND r.state IN ('requested', 'approved', 'received', 'inspected', 'resolution_ready'))`
  const [, paid] = await db.batch([
    db
      .prepare(
        `UPDATE referral_attributions
         SET status = 'rejected', rejection_reason = 'order_returned_or_refunded'
         WHERE status = 'pending_window' AND return_window_ends_at <= ?1 AND NOT (${unreturned})`
      )
      .bind(now),
    db
      .prepare(
        `UPDATE referral_attributions
         SET status = 'rewarded', reward_issued_at = ?1
         WHERE status = 'pending_window' AND return_window_ends_at <= ?1 AND ${unreturned}
           AND NOT EXISTS(SELECT 1 FROM promo_fraud_cases c
             WHERE c.context = 'referral' AND c.ref_id = referral_attributions.id
               AND (c.status IN ('upheld', 'appeal_rejected')
                 OR (c.decision = 'hold' AND c.status IN ('open', 'appealed'))))
         RETURNING reward_cents`
      )
      .bind(now)
  ])
  const rewards = ((paid as D1Result<{ reward_cents: number }>).results ?? []).map((row) => row.reward_cents)
  return { settledCount: rewards.length, settledRewardCentsTotal: rewards.reduce((sum, cents) => sum + cents, 0) }
}

export async function rejectD1ReferralAttribution(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    attributionId: string
    reason: string
    now?: string
  }
): Promise<ReferralAttributionView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 1 || reason.length > 255) fail('invalid_input')
  // Only a pending attribution can still be rejected; a paid one is never silently flipped.
  const changed = await db
    .prepare(
      `UPDATE referral_attributions
       SET status = 'rejected', rejection_reason = ?
       WHERE id = ? AND status = 'pending_window' RETURNING id`
    )
    .bind(reason, input.attributionId)
    .first<{ id: string }>()
  if (!changed) {
    const exists = await db
      .prepare(`SELECT 1 AS present FROM referral_attributions WHERE id = ?`)
      .bind(input.attributionId)
      .first()
    fail(exists ? 'conflict' : 'not_found')
  }

  const updated = await db
    .prepare(`SELECT * FROM referral_attributions WHERE id = ?`)
    .bind(input.attributionId)
    .first<Record<string, unknown>>()

  if (!updated) fail('not_found')

  return {
    id: updated.id as string,
    referralCode: updated.referral_code as string,
    advocateCustomerId: updated.advocate_customer_id as string,
    refereeCustomerId: updated.referee_customer_id as string,
    orderId: updated.order_id as string,
    orderAmountCents: updated.order_amount_cents as number,
    orderCompletedAt: updated.order_completed_at as string,
    returnWindowEndsAt: updated.return_window_ends_at as string,
    status: updated.status as 'rejected',
    rejectionReason: updated.rejection_reason as string,
    fraudCheckPassed: (updated.fraud_check_passed as number) === 1,
    fraudReasons: JSON.parse((updated.fraud_reasons as string) || '[]'),
    rewardCents: updated.reward_cents as number,
    rewardIssuedAt: updated.reward_issued_at as string | null,
    createdAt: updated.created_at as string
  }
}

export async function getD1CustomerReferralOverview(
  db: D1Database,
  customerId: string
): Promise<CustomerReferralOverview> {
  const enrollment = await db
    .prepare(
      `SELECT referral_code, terms_version, consented_at
       FROM referral_advocate_enrollments WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<{
      referral_code: string
      terms_version: string
      consented_at: string
    }>()

  if (!enrollment) {
    return {
      enrolled: false,
      totalAttributions: 0,
      pendingWindowCount: 0,
      pendingRewardCents: 0,
      rewardedCount: 0,
      totalRewardedCents: 0,
      rejectedCount: 0
    }
  }

  const attributions = await db
    .prepare(`SELECT status, reward_cents FROM referral_attributions WHERE advocate_customer_id = ?`)
    .bind(customerId)
    .all<{ status: string; reward_cents: number }>()

  let pendingWindowCount = 0
  let pendingRewardCents = 0
  let rewardedCount = 0
  let totalRewardedCents = 0
  let rejectedCount = 0

  for (const item of attributions.results || []) {
    if (item.status === 'pending_window') {
      pendingWindowCount++
      pendingRewardCents += item.reward_cents
    } else if (item.status === 'rewarded') {
      rewardedCount++
      totalRewardedCents += item.reward_cents
    } else if (item.status === 'rejected' || item.status === 'clawback') {
      rejectedCount++
    }
  }

  return {
    enrolled: true,
    referralCode: enrollment.referral_code,
    termsVersion: enrollment.terms_version,
    consentedAt: enrollment.consented_at,
    totalAttributions: (attributions.results || []).length,
    pendingWindowCount,
    pendingRewardCents,
    rewardedCount,
    totalRewardedCents,
    rejectedCount
  }
}
