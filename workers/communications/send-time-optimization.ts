import { z } from 'zod'
import {
  type SendTimeOptimizationPolicy,
  type SendTimeOptimizationPolicyInput,
  type SendTimeMessageEvaluationInput,
  type SendTimeOptimizationDecision,
  sendTimeOptimizationPolicyInputSchema,
  sendTimeMessageEvaluationInputSchema,
  calculateNextOptimalWindow,
  isCustomerHeldOut,
  sendTimeOptimizationIntentHash
} from '../../shared/send-time-optimization'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export type SendTimeOptimizationErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'service_unavailable'

export class SendTimeOptimizationError extends Error {
  constructor(readonly code: SendTimeOptimizationErrorCode) {
    super(code)
    this.name = 'SendTimeOptimizationError'
  }
}

function fail(code: SendTimeOptimizationErrorCode): never {
  throw new SendTimeOptimizationError(code)
}

export interface SendTimeOptions {
  now?: () => string
  forceHoldout?: boolean
}

function currentInstant(options?: SendTimeOptions): string {
  return options?.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface PolicyRow {
  id: string
  version: number
  holdout_rate_basis_points: number
  min_hours_between_marketing: number
  max_weekly_marketing_sends: number
  allowed_window_start_hour: number
  allowed_window_end_hour: number
  updated_at: string
  updated_by: string
}

interface DecisionRow {
  id: string
  message_id: string
  customer_id: string
  category: string
  channel: string
  campaign_code: string | null
  status: string
  scheduled_for: string
  reason: string
  holdout_applied: number
  consent_verified: number
  created_at: string
}

function mapPolicy(row: PolicyRow): SendTimeOptimizationPolicy {
  return {
    id: 'global',
    version: row.version,
    holdoutRateBasisPoints: row.holdout_rate_basis_points,
    minHoursBetweenMarketing: row.min_hours_between_marketing,
    maxWeeklyMarketingSends: row.max_weekly_marketing_sends,
    allowedWindowStartHour: row.allowed_window_start_hour,
    allowedWindowEndHour: row.allowed_window_end_hour,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

function mapDecision(row: DecisionRow): SendTimeOptimizationDecision {
  return {
    id: row.id,
    messageId: row.message_id,
    customerId: row.customer_id,
    category: row.category as SendTimeOptimizationDecision['category'],
    channel: row.channel as SendTimeOptimizationDecision['channel'],
    campaignCode: row.campaign_code,
    status: row.status as SendTimeOptimizationDecision['status'],
    scheduledFor: row.scheduled_for,
    reason: row.reason,
    holdoutApplied: row.holdout_applied === 1,
    consentVerified: row.consent_verified === 1,
    createdAt: row.created_at
  }
}

async function verifyAuth(db: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) fail('unauthenticated')
  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: false })
  if (!auth.allowed) fail(auth.code)
  return auth
}

export async function readD1SendTimePolicy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options?: SendTimeOptions
): Promise<SendTimeOptimizationPolicy> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const row = await db
    .prepare('SELECT * FROM send_time_optimization_policies WHERE id = ?')
    .bind('global')
    .first<PolicyRow>()

  if (row) return mapPolicy(row)

  // Seed default policy if missing
  const defaultRow: PolicyRow = {
    id: 'global',
    version: 1,
    holdout_rate_basis_points: 1000, // 10%
    min_hours_between_marketing: 24, // 24h cooldown
    max_weekly_marketing_sends: 3,
    allowed_window_start_hour: 9,
    allowed_window_end_hour: 18,
    updated_at: now,
    updated_by: auth.identityId
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO send_time_optimization_policies (
        id, version, holdout_rate_basis_points, min_hours_between_marketing,
        max_weekly_marketing_sends, allowed_window_start_hour, allowed_window_end_hour,
        updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      defaultRow.id,
      defaultRow.version,
      defaultRow.holdout_rate_basis_points,
      defaultRow.min_hours_between_marketing,
      defaultRow.max_weekly_marketing_sends,
      defaultRow.allowed_window_start_hour,
      defaultRow.allowed_window_end_hour,
      defaultRow.updated_at,
      defaultRow.updated_by
    )
    .run()

  const inserted = await db
    .prepare('SELECT * FROM send_time_optimization_policies WHERE id = ?')
    .bind('global')
    .first<PolicyRow>()

  return mapPolicy(inserted ?? defaultRow)
}

export async function updateD1SendTimePolicy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  idempotencyKey: string,
  rawInput: unknown,
  options?: SendTimeOptions
): Promise<SendTimeOptimizationPolicy> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const parsed = sendTimeOptimizationPolicyInputSchema.safeParse(rawInput)
  if (!parsed.success || !z.string().uuid().safeParse(commandId).success) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await sendTimeOptimizationIntentHash('update_policy', input)

  // Idempotency check
  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM send_time_optimization_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(existingCommand.receipt_json) as SendTimeOptimizationPolicy
  }

  const current = await readD1SendTimePolicy(db, claims, options)
  if (current.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = current.version + 1
  const updatedRow: PolicyRow = {
    id: 'global',
    version: nextVersion,
    holdout_rate_basis_points: input.holdoutRateBasisPoints,
    min_hours_between_marketing: input.minHoursBetweenMarketing,
    max_weekly_marketing_sends: input.maxWeeklyMarketingSends,
    allowed_window_start_hour: input.allowedWindowStartHour,
    allowed_window_end_hour: input.allowedWindowEndHour,
    updated_at: now,
    updated_by: auth.identityId
  }

  const resultPolicy = mapPolicy(updatedRow)

  await db.batch([
    db
      .prepare(
        `UPDATE send_time_optimization_policies
         SET version = ?, holdout_rate_basis_points = ?, min_hours_between_marketing = ?,
             max_weekly_marketing_sends = ?, allowed_window_start_hour = ?,
             allowed_window_end_hour = ?, updated_at = ?, updated_by = ?
         WHERE id = 'global' AND version = ?`
      )
      .bind(
        nextVersion,
        input.holdoutRateBasisPoints,
        input.minHoursBetweenMarketing,
        input.maxWeeklyMarketingSends,
        input.allowedWindowStartHour,
        input.allowedWindowEndHour,
        now,
        auth.identityId,
        input.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO send_time_optimization_commands (
          command_id, actor_id, action, idempotency_key, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        'update_policy',
        idempotencyKey,
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(resultPolicy),
        now
      )
  ])

  return resultPolicy
}

export async function evaluateD1SendTimeMessage(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  decisionId: string,
  commandId: string,
  idempotencyKey: string,
  rawInput: unknown,
  options?: SendTimeOptions
): Promise<SendTimeOptimizationDecision> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const parsed = sendTimeMessageEvaluationInputSchema.safeParse(rawInput)
  if (!parsed.success || !z.string().uuid().safeParse(decisionId).success || !z.string().uuid().safeParse(commandId).success) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await sendTimeOptimizationIntentHash('evaluate_message', input)

  // Check idempotency
  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM send_time_optimization_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(existingCommand.receipt_json) as SendTimeOptimizationDecision
  }

  // Check customer existence
  const customer = await db
    .prepare('SELECT id FROM customers WHERE id = ?')
    .bind(input.customerId)
    .first<{ id: string }>()

  if (!customer) fail('not_found')

  // Rule 1: OPERATIONAL communications MUST NEVER BE DELAYED!
  if (input.category === 'operational') {
    const decision: DecisionRow = {
      id: decisionId,
      message_id: input.messageId,
      customer_id: input.customerId,
      category: 'operational',
      channel: input.channel,
      campaign_code: input.campaignCode ?? null,
      status: 'sent_immediate',
      scheduled_for: now,
      reason: 'operational_immediate_bypass',
      holdout_applied: 0,
      consent_verified: 0,
      created_at: now
    }

    const result = mapDecision(decision)

    await db.batch([
      db
        .prepare(
          `INSERT INTO send_time_optimization_decisions (
            id, message_id, customer_id, category, channel, campaign_code,
            status, scheduled_for, reason, holdout_applied, consent_verified, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          decision.id,
          decision.message_id,
          decision.customer_id,
          decision.category,
          decision.channel,
          decision.campaign_code,
          decision.status,
          decision.scheduled_for,
          decision.reason,
          decision.holdout_applied,
          decision.consent_verified,
          decision.created_at
        ),
      db
        .prepare(
          `INSERT INTO send_time_optimization_commands (
            command_id, actor_id, action, idempotency_key, expected_version, applied_version,
            payload_hash, input_json, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          auth.identityId,
          'evaluate_message',
          idempotencyKey,
          0,
          1,
          payloadHash,
          JSON.stringify(input),
          JSON.stringify(result),
          now
        )
    ])

    return result
  }

  // Rule 2: MARKETING communications require active consent
  const subscription = await db
    .prepare(
      `SELECT s.status
       FROM newsletter_subscriptions s
       JOIN identities i ON lower(trim(i.email)) = s.email_normalized
       WHERE i.customer_id = ? AND s.status = 'confirmed' AND s.purpose = 'newsletter'`
    )
    .bind(input.customerId)
    .first<{ status: string }>()

  if (!subscription) {
    const decision: DecisionRow = {
      id: decisionId,
      message_id: input.messageId,
      customer_id: input.customerId,
      category: 'marketing',
      channel: input.channel,
      campaign_code: input.campaignCode ?? null,
      status: 'suppressed_no_consent',
      scheduled_for: now,
      reason: 'suppressed_no_consent',
      holdout_applied: 0,
      consent_verified: 0,
      created_at: now
    }

    const result = mapDecision(decision)

    await db.batch([
      db
        .prepare(
          `INSERT INTO send_time_optimization_decisions (
            id, message_id, customer_id, category, channel, campaign_code,
            status, scheduled_for, reason, holdout_applied, consent_verified, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          decision.id,
          decision.message_id,
          decision.customer_id,
          decision.category,
          decision.channel,
          decision.campaign_code,
          decision.status,
          decision.scheduled_for,
          decision.reason,
          decision.holdout_applied,
          decision.consent_verified,
          decision.created_at
        ),
      db
        .prepare(
          `INSERT INTO send_time_optimization_commands (
            command_id, actor_id, action, idempotency_key, expected_version, applied_version,
            payload_hash, input_json, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          auth.identityId,
          'evaluate_message',
          idempotencyKey,
          0,
          1,
          payloadHash,
          JSON.stringify(input),
          JSON.stringify(result),
          now
        )
    ])

    return result
  }

  const policy = await readD1SendTimePolicy(db, claims, options)

  // Rule 3: Holdout Control Group
  const isHeldOut =
    options?.forceHoldout !== undefined
      ? options.forceHoldout
      : isCustomerHeldOut(input.customerId, input.campaignCode ?? 'global', policy.holdoutRateBasisPoints)

  if (isHeldOut) {
    const decision: DecisionRow = {
      id: decisionId,
      message_id: input.messageId,
      customer_id: input.customerId,
      category: 'marketing',
      channel: input.channel,
      campaign_code: input.campaignCode ?? null,
      status: 'held_out',
      scheduled_for: now,
      reason: 'holdout_control_group',
      holdout_applied: 1,
      consent_verified: 1,
      created_at: now
    }

    const result = mapDecision(decision)

    await db.batch([
      db
        .prepare(
          `INSERT INTO send_time_optimization_decisions (
            id, message_id, customer_id, category, channel, campaign_code,
            status, scheduled_for, reason, holdout_applied, consent_verified, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          decision.id,
          decision.message_id,
          decision.customer_id,
          decision.category,
          decision.channel,
          decision.campaign_code,
          decision.status,
          decision.scheduled_for,
          decision.reason,
          decision.holdout_applied,
          decision.consent_verified,
          decision.created_at
        ),
      db
        .prepare(
          `INSERT INTO send_time_optimization_commands (
            command_id, actor_id, action, idempotency_key, expected_version, applied_version,
            payload_hash, input_json, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          auth.identityId,
          'evaluate_message',
          idempotencyKey,
          0,
          1,
          payloadHash,
          JSON.stringify(input),
          JSON.stringify(result),
          now
        )
    ])

    return result
  }

  // Rule 4: Fatigue / Rate limits
  const cooldownInstant = new Date(Date.parse(now) - policy.minHoursBetweenMarketing * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const recent = await db
    .prepare(
      `SELECT count(*) as count
       FROM send_time_optimization_decisions
       WHERE customer_id = ? AND category = 'marketing' AND status IN ('sent_immediate', 'scheduled_optimized')
         AND created_at >= ?`
    )
    .bind(input.customerId, cooldownInstant)
    .first<{ count: number }>()

  if ((recent?.count ?? 0) > 0) {
    const decision: DecisionRow = {
      id: decisionId,
      message_id: input.messageId,
      customer_id: input.customerId,
      category: 'marketing',
      channel: input.channel,
      campaign_code: input.campaignCode ?? null,
      status: 'suppressed_rate_limit',
      scheduled_for: now,
      reason: 'cooldown_active',
      holdout_applied: 0,
      consent_verified: 1,
      created_at: now
    }

    const result = mapDecision(decision)

    await db.batch([
      db
        .prepare(
          `INSERT INTO send_time_optimization_decisions (
            id, message_id, customer_id, category, channel, campaign_code,
            status, scheduled_for, reason, holdout_applied, consent_verified, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          decision.id,
          decision.message_id,
          decision.customer_id,
          decision.category,
          decision.channel,
          decision.campaign_code,
          decision.status,
          decision.scheduled_for,
          decision.reason,
          decision.holdout_applied,
          decision.consent_verified,
          decision.created_at
        ),
      db
        .prepare(
          `INSERT INTO send_time_optimization_commands (
            command_id, actor_id, action, idempotency_key, expected_version, applied_version,
            payload_hash, input_json, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          auth.identityId,
          'evaluate_message',
          idempotencyKey,
          0,
          1,
          payloadHash,
          JSON.stringify(input),
          JSON.stringify(result),
          now
        )
    ])

    return result
  }

  // Rule 5: Send-Time window optimization
  const scheduledTime = calculateNextOptimalWindow(now, policy.allowedWindowStartHour, policy.allowedWindowEndHour)

  const decision: DecisionRow = {
    id: decisionId,
    message_id: input.messageId,
    customer_id: input.customerId,
    category: 'marketing',
    channel: input.channel,
    campaign_code: input.campaignCode ?? null,
    status: 'scheduled_optimized',
    scheduled_for: scheduledTime,
    reason: 'optimal_window_scheduled',
    holdout_applied: 0,
    consent_verified: 1,
    created_at: now
  }

  const result = mapDecision(decision)

  await db.batch([
    db
      .prepare(
        `INSERT INTO send_time_optimization_decisions (
          id, message_id, customer_id, category, channel, campaign_code,
          status, scheduled_for, reason, holdout_applied, consent_verified, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        decision.id,
        decision.message_id,
        decision.customer_id,
        decision.category,
        decision.channel,
        decision.campaign_code,
        decision.status,
        decision.scheduled_for,
        decision.reason,
        decision.holdout_applied,
        decision.consent_verified,
        decision.created_at
      ),
    db
      .prepare(
        `INSERT INTO send_time_optimization_commands (
          command_id, actor_id, action, idempotency_key, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        'evaluate_message',
        idempotencyKey,
        0,
        1,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(result),
        now
      )
  ])

  return result
}

export async function listD1SendTimeDecisions(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawQuery?: { customerId?: string; status?: string; limit?: number }
): Promise<{ items: SendTimeOptimizationDecision[]; total: number }> {
  await verifyAuth(db, claims, currentInstant())

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (rawQuery?.customerId) {
    conditions.push('customer_id = ?')
    bindings.push(rawQuery.customerId)
  }
  if (rawQuery?.status) {
    conditions.push('status = ?')
    bindings.push(rawQuery.status)
  }

  const limit = Math.min(Math.max(rawQuery?.limit ?? 50, 1), 100)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = await db
    .prepare(`SELECT count(*) as count FROM send_time_optimization_decisions ${whereClause}`)
    .bind(...bindings)
    .first<{ count: number }>()

  const rows = await db
    .prepare(
      `SELECT * FROM send_time_optimization_decisions ${whereClause} ORDER BY created_at DESC LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<DecisionRow>()

  return {
    items: (rows.results ?? []).map(mapDecision),
    total: countRow?.count ?? 0
  }
}
