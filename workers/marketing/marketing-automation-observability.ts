import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type MarketingObservabilityEventInput,
  type MarketingWorkflowMetricsSummary,
  MARKETING_AUTOMATION_WORKFLOWS,
  MARKETING_WORKFLOW_LABELS,
  calculateAutomationMargin,
  calculateMarginBasisPoints,
  marketingObservabilityEventInputSchema
} from '../../shared/marketing-automation-observability'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class MarketingObservabilityError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'idempotency_conflict'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'MarketingObservabilityError'
  }
}

function fail(code: MarketingObservabilityError['code']): never {
  throw new MarketingObservabilityError(code)
}

export interface MarketingObservabilityOptions {
  now?: () => string
}

export interface MarketingCommandMeta {
  commandId?: string
  idempotencyKey?: string
}

function instant(options?: MarketingObservabilityOptions): string {
  const raw = options?.now?.() ?? new Date().toISOString()
  return catalogPolicyInstantSchema.parse(raw.replace(/\.\d{3}Z$/, 'Z'))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function assertAuthorized(database: D1Database, claims: VerifiedSessionClaims, nowIso: string): Promise<void> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', {
    now: nowIso,
    requireMfa: true
  })
  if (!auth.allowed) {
    fail(auth.code)
  }
}

interface CommandRow {
  command_id: string
  payload_hash: string
  receipt_json: string
}

interface EventRow {
  id: string
  workflow_id: string
  execution_id: string
  event_type: string
  channel: string
  customer_id: string | null
  suppression_reason: string | null
  error_code: string | null
  error_message: string | null
  discount_cents: number
  gross_revenue_cents: number
  cost_cents: number
  metadata_json: string
  occurred_at: string
  created_at: string
}

export async function recordD1MarketingAutomationEvent(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: MarketingObservabilityEventInput,
  commandMeta?: MarketingCommandMeta,
  options?: MarketingObservabilityOptions
): Promise<{ eventId: string }> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)
  const parsed = marketingObservabilityEventInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const commandId = commandMeta?.commandId ?? crypto.randomUUID()
  const idempotencyKey =
    commandMeta?.idempotencyKey ??
    `mkt-ev-${parsed.data.workflowId}-${parsed.data.executionId}-${parsed.data.eventType}`
  const payloadString = JSON.stringify(parsed.data)
  const payloadHash = await sha256Hex(payloadString)

  // Idempotency check
  const existingCmd = await database
    .prepare(
      'SELECT command_id, payload_hash, receipt_json FROM marketing_automation_observability_commands WHERE actor_id = ?1 AND idempotency_key = ?2'
    )
    .bind(claims.identityId, idempotencyKey)
    .first<CommandRow>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) fail('idempotency_conflict')
    const receipt = JSON.parse(existingCmd.receipt_json) as { eventId: string }
    return receipt
  }

  const eventId = crypto.randomUUID()

  await database
    .prepare(
      `INSERT INTO marketing_automation_observability_events (
        id, workflow_id, execution_id, event_type, channel,
        customer_id, suppression_reason, error_code, error_message,
        discount_cents, gross_revenue_cents, cost_cents, metadata_json,
        occurred_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    )
    .bind(
      eventId,
      parsed.data.workflowId,
      parsed.data.executionId,
      parsed.data.eventType,
      parsed.data.channel,
      parsed.data.customerId ?? null,
      parsed.data.suppressionReason ?? null,
      parsed.data.errorCode ?? null,
      parsed.data.errorMessage ?? null,
      parsed.data.discountCents,
      parsed.data.grossRevenueCents,
      parsed.data.costCents,
      JSON.stringify(parsed.data.metadata ?? {}),
      parsed.data.occurredAt,
      nowIso
    )
    .run()

  const receipt = { eventId }
  await database
    .prepare(
      `INSERT INTO marketing_automation_observability_commands (
        command_id, actor_id, action, idempotency_key, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      claims.identityId,
      'record_event',
      idempotencyKey,
      payloadHash,
      payloadString,
      JSON.stringify(receipt),
      nowIso
    )
    .run()

  return receipt
}

interface AggregateRow {
  workflow_id: string
  triggers: number
  suppressions: number
  deliveries: number
  conversions: number
  complaints: number
  errors: number
  total_gross_revenue: number
  total_cost: number
  total_discount: number
}

interface SuppressionGroupRow {
  workflow_id: string
  suppression_reason: string
  count: number
}

interface ErrorGroupRow {
  workflow_id: string
  error_code: string
  count: number
}

export async function getD1WorkflowMetricsSummary(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: MarketingObservabilityOptions & { timeWindowDays?: number }
): Promise<MarketingWorkflowMetricsSummary[]> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)

  // Query aggregates
  const aggResult = await database
    .prepare(
      `SELECT
        workflow_id,
        SUM(CASE WHEN event_type = 'trigger' THEN 1 ELSE 0 END) AS triggers,
        SUM(CASE WHEN event_type = 'suppression' THEN 1 ELSE 0 END) AS suppressions,
        SUM(CASE WHEN event_type = 'delivery' THEN 1 ELSE 0 END) AS deliveries,
        SUM(CASE WHEN event_type = 'conversion' THEN 1 ELSE 0 END) AS conversions,
        SUM(CASE WHEN event_type = 'complaint' THEN 1 ELSE 0 END) AS complaints,
        SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) AS errors,
        COALESCE(SUM(CASE WHEN event_type = 'conversion' THEN gross_revenue_cents ELSE 0 END), 0) AS total_gross_revenue,
        COALESCE(SUM(CASE WHEN event_type = 'conversion' THEN cost_cents ELSE 0 END), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN event_type = 'conversion' THEN discount_cents ELSE 0 END), 0) AS total_discount
      FROM marketing_automation_observability_events
      GROUP BY workflow_id`
    )
    .all<AggregateRow>()

  // Query suppression breakdown
  const suppResult = await database
    .prepare(
      `SELECT workflow_id, suppression_reason, COUNT(*) AS count
       FROM marketing_automation_observability_events
       WHERE event_type = 'suppression' AND suppression_reason IS NOT NULL
       GROUP BY workflow_id, suppression_reason`
    )
    .all<SuppressionGroupRow>()

  const suppressionMap = new Map<string, Record<string, number>>()
  for (const row of suppResult.results ?? []) {
    if (!suppressionMap.has(row.workflow_id)) {
      suppressionMap.set(row.workflow_id, {})
    }
    suppressionMap.get(row.workflow_id)![row.suppression_reason] = row.count
  }

  // Query error breakdown
  const errResult = await database
    .prepare(
      `SELECT workflow_id, error_code, COUNT(*) AS count
       FROM marketing_automation_observability_events
       WHERE event_type = 'error' AND error_code IS NOT NULL
       GROUP BY workflow_id, error_code`
    )
    .all<ErrorGroupRow>()

  const errorMap = new Map<string, Record<string, number>>()
  for (const row of errResult.results ?? []) {
    if (!errorMap.has(row.workflow_id)) {
      errorMap.set(row.workflow_id, {})
    }
    errorMap.get(row.workflow_id)![row.error_code] = row.count
  }

  const existingWorkflows = new Map<string, AggregateRow>()
  for (const row of aggResult.results ?? []) {
    existingWorkflows.set(row.workflow_id, row)
  }

  // Include all standard workflows and any observed workflows
  const allWorkflowIds = new Set<string>([...MARKETING_AUTOMATION_WORKFLOWS, ...existingWorkflows.keys()])

  const summaries: MarketingWorkflowMetricsSummary[] = []

  for (const workflowId of allWorkflowIds) {
    const row = existingWorkflows.get(workflowId)
    const triggers = row ? Number(row.triggers) : 0
    const suppressions = row ? Number(row.suppressions) : 0
    const deliveries = row ? Number(row.deliveries) : 0
    const conversions = row ? Number(row.conversions) : 0
    const complaints = row ? Number(row.complaints) : 0
    const errors = row ? Number(row.errors) : 0

    const totalGrossRevenueCents = row ? Number(row.total_gross_revenue) : 0
    const totalCostCents = row ? Number(row.total_cost) : 0
    const totalDiscountCents = row ? Number(row.total_discount) : 0

    const totalNetMarginCents = calculateAutomationMargin(totalGrossRevenueCents, totalCostCents, totalDiscountCents)
    const marginBasisPoints = calculateMarginBasisPoints(totalNetMarginCents, totalGrossRevenueCents)

    const deliveryRatePercent = triggers > 0 ? (deliveries / triggers) * 100 : 0
    const conversionRatePercent = deliveries > 0 ? (conversions / deliveries) * 100 : 0
    const complaintRatePercent = deliveries > 0 ? (complaints / deliveries) * 100 : 0
    const errorRatePercent = triggers > 0 ? (errors / triggers) * 100 : 0

    const hasHighErrorRate = errorRatePercent >= 5.0 && errors > 0
    const hasHighComplaintRate = complaintRatePercent >= 1.0 && complaints > 0
    const hasNegativeMargin = totalNetMarginCents < 0

    summaries.push({
      workflowId,
      workflowName: MARKETING_WORKFLOW_LABELS[workflowId] ?? workflowId,
      triggers,
      suppressions,
      deliveries,
      conversions,
      complaints,
      errors,
      totalGrossRevenueCents,
      totalCostCents,
      totalDiscountCents,
      totalNetMarginCents,
      marginBasisPoints,
      deliveryRatePercent: Math.round(deliveryRatePercent * 100) / 100,
      conversionRatePercent: Math.round(conversionRatePercent * 100) / 100,
      complaintRatePercent: Math.round(complaintRatePercent * 100) / 100,
      errorRatePercent: Math.round(errorRatePercent * 100) / 100,
      suppressionBreakdown: suppressionMap.get(workflowId) ?? {},
      errorBreakdown: errorMap.get(workflowId) ?? {},
      hasHighErrorRate,
      hasHighComplaintRate,
      hasNegativeMargin
    })
  }

  return summaries
}

export async function getD1WorkflowMetricsDetail(
  database: D1Database,
  claims: VerifiedSessionClaims,
  workflowId: string,
  options?: MarketingObservabilityOptions
): Promise<MarketingWorkflowMetricsSummary> {
  const summaries = await getD1WorkflowMetricsSummary(database, claims, options)
  const found = summaries.find((s) => s.workflowId === workflowId)
  if (!found) {
    fail('not_found')
  }
  return found
}

export async function listD1MarketingEvents(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query?: { workflowId?: string; eventType?: string; limit?: number },
  options?: MarketingObservabilityOptions
): Promise<EventRow[]> {
  const nowIso = instant(options)
  await assertAuthorized(database, claims, nowIso)

  let sql = 'SELECT * FROM marketing_automation_observability_events WHERE 1=1'
  const params: unknown[] = []

  if (query?.workflowId) {
    params.push(query.workflowId)
    sql += ` AND workflow_id = ?${params.length}`
  }

  if (query?.eventType) {
    params.push(query.eventType)
    sql += ` AND event_type = ?${params.length}`
  }

  sql += ' ORDER BY occurred_at DESC'
  const limit = Math.min(query?.limit ?? 50, 200)
  params.push(limit)
  sql += ` LIMIT ?${params.length}`

  const stmt = database.prepare(sql)
  const result = await stmt.bind(...params).all<EventRow>()

  return result.results ?? []
}
