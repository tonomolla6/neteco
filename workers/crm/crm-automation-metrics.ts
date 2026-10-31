import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type CrmAutomationEventInput,
  type CrmHoldoutPolicy,
  type CrmHoldoutPolicyInput,
  type CrmHoldoutEvaluationInput,
  type FlowMetricsSummary,
  type TreatmentMetrics,
  type HoldoutMetrics,
  calculateDeterministicHoldoutGroup,
  calculateIncrementalLift,
  calculateMargin,
  crmHoldoutPolicySchema,
  crmHoldoutPolicyInputSchema,
  crmAutomationEventInputSchema,
  crmHoldoutEvaluationInputSchema,
  CRM_AUTOMATION_FLOWS
} from '../../shared/crm-automation-metrics'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class CrmAutomationMetricsError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'CrmAutomationMetricsError'
  }
}

function fail(code: CrmAutomationMetricsError['code']): never {
  throw new CrmAutomationMetricsError(code)
}

export interface CrmAutomationMetricsOptions {
  now?: () => string
}

const DEFAULT_SALT = 'neteco_crm_salt_2026'

const DEFAULT_POLICY: Omit<CrmHoldoutPolicy, 'flowId'> = {
  version: 1,
  holdoutPercentage: 10,
  holdoutEnabled: true,
  salt: DEFAULT_SALT,
  minSampleSize: 20,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

function instant(options?: CrmAutomationMetricsOptions): string {
  const raw = options?.now?.() ?? new Date().toISOString()
  return catalogPolicyInstantSchema.parse(raw.replace(/\.\d{3}Z$/, 'Z'))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function requireAdmin(db: D1Database, claims: VerifiedSessionClaims, options?: CrmAutomationMetricsOptions) {
  const now = instant(options)
  const auth = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    now
  })
  if (!auth.allowed) {
    if (auth.code === 'mfa_required') fail('mfa_required')
    if (auth.code === 'unauthenticated') fail('unauthenticated')
    if (auth.code === 'email_unverified') fail('email_unverified')
    fail('forbidden')
  }
}

export async function readD1HoldoutPolicy(db: D1Database, flowId: string): Promise<CrmHoldoutPolicy> {
  const row = await db
    .prepare(
      `SELECT flow_id, version, holdout_percentage, holdout_enabled, salt, min_sample_size, updated_at, updated_by
       FROM crm_automation_holdout_policies
       WHERE flow_id = ?`
    )
    .bind(flowId)
    .first<Record<string, unknown>>()

  if (!row) {
    return crmHoldoutPolicySchema.parse({
      flowId,
      ...DEFAULT_POLICY
    })
  }

  return crmHoldoutPolicySchema.parse({
    flowId: row.flow_id,
    version: row.version,
    holdoutPercentage: row.holdout_percentage,
    holdoutEnabled: row.holdout_enabled === 1,
    salt: row.salt,
    minSampleSize: row.min_sample_size,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  })
}

export async function updateD1HoldoutPolicy(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: CrmHoldoutPolicyInput,
  idempotencyKey: string,
  options?: CrmAutomationMetricsOptions
): Promise<{ appliedVersion: number; receiptId: string }> {
  await requireAdmin(db, claims, options)

  const parsed = crmHoldoutPolicyInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const { flowId, holdoutPercentage, holdoutEnabled, minSampleSize, expectedVersion } = parsed.data

  const now = instant(options)
  const payloadHash = await sha256Hex(
    JSON.stringify({ flowId, holdoutPercentage, holdoutEnabled, minSampleSize, expectedVersion })
  )

  // Check idempotency
  const existingCommand = await db
    .prepare(
      `SELECT payload_hash, receipt_json FROM crm_automation_metrics_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existingPolicy = await readD1HoldoutPolicy(db, flowId)
  if (existingPolicy.version !== expectedVersion) {
    fail('version_conflict')
  }

  const nextVersion = existingPolicy.version + 1
  const commandId = crypto.randomUUID()

  // Insert or Update policy in D1
  const policyCheck = await db
    .prepare('SELECT version FROM crm_automation_holdout_policies WHERE flow_id = ?')
    .bind(flowId)
    .first<{ version: number }>()

  if (!policyCheck) {
    // Initial insert
    await db
      .prepare(
        `INSERT INTO crm_automation_holdout_policies
          (flow_id, version, holdout_percentage, holdout_enabled, salt, min_sample_size, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        flowId,
        nextVersion,
        holdoutPercentage,
        holdoutEnabled ? 1 : 0,
        DEFAULT_SALT,
        minSampleSize,
        now,
        claims.identityId
      )
      .run()
  } else {
    try {
      await db
        .prepare(
          `UPDATE crm_automation_holdout_policies
           SET version = ?, holdout_percentage = ?, holdout_enabled = ?, min_sample_size = ?, updated_at = ?, updated_by = ?
           WHERE flow_id = ? AND version = ?`
        )
        .bind(
          nextVersion,
          holdoutPercentage,
          holdoutEnabled ? 1 : 0,
          minSampleSize,
          now,
          claims.identityId,
          flowId,
          expectedVersion
        )
        .run()
    } catch {
      fail('version_conflict')
    }
  }

  const receipt = { appliedVersion: nextVersion, receiptId: commandId }

  await db
    .prepare(
      `INSERT INTO crm_automation_metrics_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'configure_holdout', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      idempotencyKey,
      expectedVersion,
      nextVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify(receipt),
      now
    )
    .run()

  return receipt
}

export async function evaluateD1HoldoutAllocation(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: CrmHoldoutEvaluationInput,
  options?: CrmAutomationMetricsOptions
): Promise<{ groupType: 'treatment' | 'holdout'; allocationId: string }> {
  await requireAdmin(db, claims, options)

  const parsed = crmHoldoutEvaluationInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const { flowId, step, customerId, idempotencyKey } = parsed.data

  const now = instant(options)
  const payloadHash = await sha256Hex(JSON.stringify({ flowId, step, customerId }))

  // Check existing command
  const existingCommand = await db
    .prepare(
      `SELECT payload_hash, receipt_json FROM crm_automation_metrics_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Check existing allocation in table
  const existingAlloc = await db
    .prepare(
      `SELECT id, group_type FROM crm_automation_holdout_allocations
       WHERE flow_id = ? AND step = ? AND customer_id = ?`
    )
    .bind(flowId, step, customerId)
    .first<{ id: string; group_type: 'treatment' | 'holdout' }>()

  if (existingAlloc) {
    const receipt = { groupType: existingAlloc.group_type, allocationId: existingAlloc.id }
    return receipt
  }

  const policy = await readD1HoldoutPolicy(db, flowId)
  const groupType = await calculateDeterministicHoldoutGroup(
    customerId,
    flowId,
    policy.salt,
    policy.holdoutPercentage,
    policy.holdoutEnabled
  )

  const allocationId = crypto.randomUUID()

  await db
    .prepare(
      `INSERT INTO crm_automation_holdout_allocations (id, flow_id, step, customer_id, group_type, allocated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(allocationId, flowId, step, customerId, groupType, now)
    .run()

  const commandId = crypto.randomUUID()
  const receipt = { groupType, allocationId }

  await db
    .prepare(
      `INSERT INTO crm_automation_metrics_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'allocate_holdout', ?, 0, 1, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      idempotencyKey,
      payloadHash,
      JSON.stringify(parsed.data),
      JSON.stringify(receipt),
      now
    )
    .run()

  return receipt
}

export async function recordD1AutomationEvent(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: CrmAutomationEventInput,
  options?: CrmAutomationMetricsOptions
): Promise<{ eventId: string }> {
  await requireAdmin(db, claims, options)

  const parsed = crmAutomationEventInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const data = parsed.data

  const now = instant(options)
  const payloadHash = await sha256Hex(JSON.stringify(data))

  // Idempotency
  const existingCommand = await db
    .prepare(
      `SELECT payload_hash, receipt_json FROM crm_automation_metrics_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, data.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Margin calculation if revenue and cost are provided
  let marginCents: number | null = null
  let marginBasisPoints: number | null = null
  if (data.revenueCents !== undefined && data.costCents !== undefined) {
    const calc = calculateMargin(data.revenueCents, data.costCents)
    marginCents = calc.marginCents
    marginBasisPoints = calc.marginBasisPoints
  }

  const eventId = crypto.randomUUID()

  await db
    .prepare(
      `INSERT INTO crm_automation_events
        (id, flow_id, step, customer_id, group_type, event_type, order_id, revenue_cents, cost_cents, margin_cents, margin_basis_points, metadata_json, payload_hash, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      eventId,
      data.flowId,
      data.step,
      data.customerId,
      data.groupType,
      data.eventType,
      data.orderId ?? null,
      data.revenueCents ?? null,
      data.costCents ?? null,
      marginCents,
      marginBasisPoints,
      JSON.stringify(data.metadata),
      payloadHash,
      data.occurredAt,
      now
    )
    .run()

  const commandId = crypto.randomUUID()
  const receipt = { eventId }

  await db
    .prepare(
      `INSERT INTO crm_automation_metrics_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'record_event', ?, 0, 1, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      data.idempotencyKey,
      payloadHash,
      JSON.stringify(data),
      JSON.stringify(receipt),
      now
    )
    .run()

  return receipt
}

export async function getD1FlowMetricsSummary(
  db: D1Database,
  flowId: string,
  _options?: CrmAutomationMetricsOptions
): Promise<FlowMetricsSummary> {
  const policy = await readD1HoldoutPolicy(db, flowId)

  // Query events aggregated by group_type and event_type
  const rows = await db
    .prepare(
      `SELECT
         group_type,
         event_type,
         COUNT(*) as count,
         COALESCE(SUM(revenue_cents), 0) as total_revenue,
         COALESCE(SUM(cost_cents), 0) as total_cost,
         COALESCE(SUM(margin_cents), 0) as total_margin
       FROM crm_automation_events
       WHERE flow_id = ?
       GROUP BY group_type, event_type`
    )
    .bind(flowId)
    .all<{
      group_type: 'treatment' | 'holdout'
      event_type: string
      count: number
      total_revenue: number
      total_cost: number
      total_margin: number
    }>()

  // Query holdout allocations count
  const holdoutAllocRow = await db
    .prepare(
      `SELECT COUNT(*) as count FROM crm_automation_holdout_allocations
       WHERE flow_id = ? AND group_type = 'holdout'`
    )
    .bind(flowId)
    .first<{ count: number }>()

  const eventMap: Record<string, { count: number; rev: number; cost: number; margin: number }> = {}
  for (const r of rows.results ?? []) {
    const key = `${r.group_type}:${r.event_type}`
    eventMap[key] = {
      count: Number(r.count),
      rev: Number(r.total_revenue),
      cost: Number(r.total_cost),
      margin: Number(r.total_margin)
    }
  }

  // Treatment stats
  const tDeliv = eventMap['treatment:delivery']?.count ?? 0
  const tClick = eventMap['treatment:click']?.count ?? 0
  const tConv = eventMap['treatment:conversion']?.count ?? 0
  const tUnsub = eventMap['treatment:unsubscribe']?.count ?? 0
  const tComp = eventMap['treatment:complaint']?.count ?? 0
  const tRev = eventMap['treatment:conversion']?.rev ?? 0
  const tCost = eventMap['treatment:conversion']?.cost ?? 0
  const tMargin = eventMap['treatment:conversion']?.margin ?? 0

  const treatment: TreatmentMetrics = {
    deliveries: tDeliv,
    clicks: tClick,
    ctrPercent: tDeliv > 0 ? Math.round((tClick / tDeliv) * 10000) / 100 : 0,
    conversions: tConv,
    conversionRatePercent: tDeliv > 0 ? Math.round((tConv / tDeliv) * 10000) / 100 : 0,
    unsubscribes: tUnsub,
    unsubscribeRatePercent: tDeliv > 0 ? Math.round((tUnsub / tDeliv) * 10000) / 100 : 0,
    complaints: tComp,
    complaintRatePercent: tDeliv > 0 ? Math.round((tComp / tDeliv) * 10000) / 100 : 0,
    totalRevenueCents: tRev,
    totalCostCents: tCost,
    totalMarginCents: tMargin,
    marginBasisPoints: tRev > 0 ? Math.floor((tMargin * 10000) / tRev) : 0,
    averageOrderValueCents: tConv > 0 ? Math.round(tRev / tConv) : 0
  }

  // Holdout stats
  const hAlloc = Number(holdoutAllocRow?.count ?? 0)
  const hConv = eventMap['holdout:conversion']?.count ?? 0
  const hRev = eventMap['holdout:conversion']?.rev ?? 0
  const hCost = eventMap['holdout:conversion']?.cost ?? 0
  const hMargin = eventMap['holdout:conversion']?.margin ?? 0

  const holdout: HoldoutMetrics = {
    allocations: hAlloc,
    conversions: hConv,
    conversionRatePercent: hAlloc > 0 ? Math.round((hConv / hAlloc) * 10000) / 100 : 0,
    totalRevenueCents: hRev,
    totalCostCents: hCost,
    totalMarginCents: hMargin,
    marginBasisPoints: hRev > 0 ? Math.floor((hMargin * 10000) / hRev) : 0,
    averageOrderValueCents: hConv > 0 ? Math.round(hRev / hConv) : 0
  }

  const incremental = calculateIncrementalLift(treatment, holdout, policy.minSampleSize, policy.holdoutEnabled)

  return {
    flowId,
    treatment,
    holdout,
    incremental,
    holdoutPolicy: policy
  }
}

export async function listD1FlowMetricsOverview(
  db: D1Database,
  options?: CrmAutomationMetricsOptions
): Promise<FlowMetricsSummary[]> {
  const summaries: FlowMetricsSummary[] = []
  for (const flowId of CRM_AUTOMATION_FLOWS) {
    const summary = await getD1FlowMetricsSummary(db, flowId, options)
    summaries.push(summary)
  }
  return summaries
}
