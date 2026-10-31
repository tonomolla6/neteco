import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type AnomalyAlert,
  type AnomalyAlertsQuery,
  type AnomalyDimension,
  type AnomalyPolicy,
  type AnomalyPolicyInput,
  type AnomalyReview,
  type AnomalyReviewInput,
  type AnomalyRunbook,
  type AnomalySignalInput,
  ANOMALY_DIMENSIONS,
  anomalyAlertSchema,
  anomalyAlertsQuerySchema,
  anomalyPolicyInputSchema,
  anomalyPolicySchema,
  anomalyReviewInputSchema,
  anomalySignalInputSchema,
  evaluateAnomalyDrop,
  getRunbookForDimension
} from '../../shared/anomaly-detection'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class AnomalyDetectionError extends Error {
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
    this.name = 'AnomalyDetectionError'
  }
}

function fail(code: AnomalyDetectionError['code']): never {
  throw new AnomalyDetectionError(code)
}

export interface AnomalyDetectionOptions {
  now?: () => string
}

function instant(options?: AnomalyDetectionOptions): string {
  const raw = options?.now?.() ?? new Date().toISOString()
  return catalogPolicyInstantSchema.parse(raw.replace(/\.\d{3}Z$/, 'Z'))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const DEFAULT_POLICIES: Record<AnomalyDimension, Omit<AnomalyPolicy, 'dimension'>> = {
  conversion: {
    version: 1,
    warningDropPercent: 25,
    criticalDropPercent: 50,
    minSampleSize: 20,
    evaluationWindowMinutes: 60,
    cooldownMinutes: 60,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: '00000000-0000-4000-8000-000000000000'
  },
  payment: {
    version: 1,
    warningDropPercent: 20,
    criticalDropPercent: 40,
    minSampleSize: 15,
    evaluationWindowMinutes: 30,
    cooldownMinutes: 60,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: '00000000-0000-4000-8000-000000000000'
  },
  stock: {
    version: 1,
    warningDropPercent: 30,
    criticalDropPercent: 70,
    minSampleSize: 10,
    evaluationWindowMinutes: 120,
    cooldownMinutes: 120,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: '00000000-0000-4000-8000-000000000000'
  },
  tracking: {
    version: 1,
    warningDropPercent: 30,
    criticalDropPercent: 60,
    minSampleSize: 50,
    evaluationWindowMinutes: 60,
    cooldownMinutes: 60,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: '00000000-0000-4000-8000-000000000000'
  },
  data: {
    version: 1,
    warningDropPercent: 25,
    criticalDropPercent: 50,
    minSampleSize: 10,
    evaluationWindowMinutes: 120,
    cooldownMinutes: 120,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: '00000000-0000-4000-8000-000000000000'
  }
}

async function requireManagePermission(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options?: AnomalyDetectionOptions
) {
  const now = instant(options)
  const authAdmin = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    now
  })
  if (authAdmin.allowed) return

  const authOps = await authorizeD1Session(db, claims, 'operations.manage', {
    requireMfa: true,
    now
  })
  if (authOps.allowed) return

  if (authAdmin.code === 'mfa_required' || authOps.code === 'mfa_required') fail('mfa_required')
  if (authAdmin.code === 'unauthenticated' || authOps.code === 'unauthenticated') fail('unauthenticated')
  if (authAdmin.code === 'email_unverified' || authOps.code === 'email_unverified') fail('email_unverified')
  fail('forbidden')
}

export async function readD1AnomalyPolicy(db: D1Database, dimension: AnomalyDimension): Promise<AnomalyPolicy> {
  const row = await db
    .prepare(
      `SELECT dimension, version, warning_drop_percent, critical_drop_percent, min_sample_size,
              evaluation_window_minutes, cooldown_minutes, enabled, updated_at, updated_by
       FROM anomaly_detection_policies
       WHERE dimension = ?`
    )
    .bind(dimension)
    .first<Record<string, unknown>>()

  if (!row) {
    return anomalyPolicySchema.parse({
      dimension,
      ...DEFAULT_POLICIES[dimension]
    })
  }

  return anomalyPolicySchema.parse({
    dimension: row.dimension,
    version: row.version,
    warningDropPercent: row.warning_drop_percent,
    criticalDropPercent: row.critical_drop_percent,
    minSampleSize: row.min_sample_size,
    evaluationWindowMinutes: row.evaluation_window_minutes,
    cooldownMinutes: row.cooldown_minutes,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  })
}

export async function listD1AnomalyPolicies(db: D1Database): Promise<AnomalyPolicy[]> {
  const policies: AnomalyPolicy[] = []
  for (const dim of ANOMALY_DIMENSIONS) {
    const p = await readD1AnomalyPolicy(db, dim)
    policies.push(p)
  }
  return policies
}

export async function updateD1AnomalyPolicy(
  db: D1Database,
  claims: VerifiedSessionClaims,
  dimension: AnomalyDimension,
  input: AnomalyPolicyInput,
  idempotencyKey: string,
  options?: AnomalyDetectionOptions
): Promise<{ appliedVersion: number; receiptId: string }> {
  await requireManagePermission(db, claims, options)

  const parsed = anomalyPolicyInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const data = parsed.data

  const now = instant(options)
  const payloadHash = await sha256Hex(JSON.stringify({ dimension, ...data }))

  // Check idempotency
  const existingCommand = await db
    .prepare(
      `SELECT payload_hash, receipt_json FROM anomaly_commands
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

  const existingPolicy = await readD1AnomalyPolicy(db, dimension)
  if (existingPolicy.version !== data.expectedVersion) {
    fail('version_conflict')
  }

  const nextVersion = existingPolicy.version + 1
  const commandId = crypto.randomUUID()

  const checkRow = await db
    .prepare('SELECT version FROM anomaly_detection_policies WHERE dimension = ?')
    .bind(dimension)
    .first<{ version: number }>()

  if (!checkRow) {
    await db
      .prepare(
        `INSERT INTO anomaly_detection_policies
          (dimension, version, warning_drop_percent, critical_drop_percent, min_sample_size, evaluation_window_minutes, cooldown_minutes, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        dimension,
        nextVersion,
        data.warningDropPercent,
        data.criticalDropPercent,
        data.minSampleSize,
        data.evaluationWindowMinutes,
        data.cooldownMinutes,
        data.enabled ? 1 : 0,
        now,
        claims.identityId
      )
      .run()
  } else {
    try {
      await db
        .prepare(
          `UPDATE anomaly_detection_policies
           SET version = ?, warning_drop_percent = ?, critical_drop_percent = ?, min_sample_size = ?, evaluation_window_minutes = ?, cooldown_minutes = ?, enabled = ?, updated_at = ?, updated_by = ?
           WHERE dimension = ? AND version = ?`
        )
        .bind(
          nextVersion,
          data.warningDropPercent,
          data.criticalDropPercent,
          data.minSampleSize,
          data.evaluationWindowMinutes,
          data.cooldownMinutes,
          data.enabled ? 1 : 0,
          now,
          claims.identityId,
          dimension,
          data.expectedVersion
        )
        .run()
    } catch {
      fail('version_conflict')
    }
  }

  const receipt = { appliedVersion: nextVersion, receiptId: commandId }

  await db
    .prepare(
      `INSERT INTO anomaly_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'update_policy', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      idempotencyKey,
      data.expectedVersion,
      nextVersion,
      payloadHash,
      JSON.stringify(data),
      JSON.stringify(receipt),
      now
    )
    .run()

  return receipt
}

export async function evaluateD1AnomalySignal(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: AnomalySignalInput,
  options?: AnomalyDetectionOptions
): Promise<{
  isAnomaly: boolean
  alertCreated: boolean
  alert?: AnomalyAlert
  reason?: string
}> {
  await requireManagePermission(db, claims, options)

  const parsed = anomalySignalInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const data = parsed.data

  const policy = await readD1AnomalyPolicy(db, data.dimension)
  const evalResult = evaluateAnomalyDrop(data.baselineValue, data.observedValue, data.sampleSize, policy)

  if (!evalResult.isAnomaly || !evalResult.severity) {
    return {
      isAnomaly: false,
      alertCreated: false,
      reason: evalResult.reason
    }
  }

  const now = instant(options)
  const nowMs = new Date(now).getTime()

  // Cooldown noise avoidance: check if an alert for this dimension and metric_name was created within cooldown window
  if (policy.cooldownMinutes > 0) {
    const cooldownCutoff = new Date(nowMs - policy.cooldownMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const recentAlert = await db
      .prepare(
        `SELECT id FROM anomaly_alerts
         WHERE dimension = ? AND metric_name = ? AND detected_at >= ? AND status IN ('open', 'acknowledged', 'under_investigation')`
      )
      .bind(data.dimension, data.metricName, cooldownCutoff)
      .first<{ id: string }>()

    if (recentAlert) {
      return {
        isAnomaly: true,
        alertCreated: false,
        reason: `cooldown_active (alert ${recentAlert.id} within last ${policy.cooldownMinutes}m)`
      }
    }
  }

  // Create new Anomaly Alert
  const runbook = getRunbookForDimension(data.dimension)
  const alertId = crypto.randomUUID()
  const summary = `Caída anómala de ${evalResult.dropPercent}% en ${data.metricName} (base: ${data.baselineValue}, actual: ${data.observedValue}, muestra: ${data.sampleSize})`

  await db
    .prepare(
      `INSERT INTO anomaly_alerts
        (id, dimension, metric_name, severity, status, baseline_value, observed_value, deviation_percent, sample_size, threshold_applied, runbook_id, runbook_title, summary, detected_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      alertId,
      data.dimension,
      data.metricName,
      evalResult.severity,
      data.baselineValue,
      data.observedValue,
      evalResult.dropPercent,
      data.sampleSize,
      evalResult.severity === 'critical' ? policy.criticalDropPercent : policy.warningDropPercent,
      runbook.runbookId,
      runbook.title,
      summary,
      data.detectedAt,
      now,
      now
    )
    .run()

  const alert = await getD1AnomalyAlert(db, alertId)

  // Log command
  const commandId = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))
  await db
    .prepare(
      `INSERT INTO anomaly_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'evaluate_signal', ?, 0, 1, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      data.idempotencyKey,
      payloadHash,
      JSON.stringify(data),
      JSON.stringify({ alertId }),
      now
    )
    .run()

  return {
    isAnomaly: true,
    alertCreated: true,
    alert
  }
}

export async function getD1AnomalyAlert(db: D1Database, alertId: string): Promise<AnomalyAlert> {
  const row = await db
    .prepare(
      `SELECT id, dimension, metric_name, severity, status, baseline_value, observed_value, deviation_percent,
              sample_size, threshold_applied, runbook_id, runbook_title, summary, detected_at, version,
              reviewer_id, reviewed_at, review_notes, resolution_action, created_at, updated_at
       FROM anomaly_alerts
       WHERE id = ?`
    )
    .bind(alertId)
    .first<Record<string, unknown>>()

  if (!row) fail('not_found')

  return anomalyAlertSchema.parse({
    id: row.id,
    dimension: row.dimension,
    metricName: row.metric_name,
    severity: row.severity,
    status: row.status,
    baselineValue: row.baseline_value,
    observedValue: row.observed_value,
    deviationPercent: row.deviation_percent,
    sampleSize: row.sample_size,
    thresholdApplied: row.threshold_applied,
    runbookId: row.runbook_id,
    runbookTitle: row.runbook_title,
    summary: row.summary,
    detectedAt: row.detected_at,
    version: row.version,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    resolutionAction: row.resolution_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export async function listD1AnomalyAlerts(
  db: D1Database,
  query?: AnomalyAlertsQuery
): Promise<{ items: AnomalyAlert[]; total: number }> {
  const parsed = anomalyAlertsQuerySchema.parse(query ?? {})
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (parsed.dimension) {
    conditions.push('dimension = ?')
    bindings.push(parsed.dimension)
  }
  if (parsed.severity) {
    conditions.push('severity = ?')
    bindings.push(parsed.severity)
  }
  if (parsed.status) {
    conditions.push('status = ?')
    bindings.push(parsed.status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = await db
    .prepare(`SELECT COUNT(*) as count FROM anomaly_alerts ${whereClause}`)
    .bind(...bindings)
    .first<{ count: number }>()

  const total = Number(countRow?.count ?? 0)

  const rows = await db
    .prepare(
      `SELECT id, dimension, metric_name, severity, status, baseline_value, observed_value, deviation_percent,
              sample_size, threshold_applied, runbook_id, runbook_title, summary, detected_at, version,
              reviewer_id, reviewed_at, review_notes, resolution_action, created_at, updated_at
       FROM anomaly_alerts
       ${whereClause}
       ORDER BY detected_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...bindings, parsed.limit, parsed.offset)
    .all<Record<string, unknown>>()

  const items = (rows.results ?? []).map((r) =>
    anomalyAlertSchema.parse({
      id: r.id,
      dimension: r.dimension,
      metricName: r.metric_name,
      severity: r.severity,
      status: r.status,
      baselineValue: r.baseline_value,
      observedValue: r.observed_value,
      deviationPercent: r.deviation_percent,
      sampleSize: r.sample_size,
      thresholdApplied: r.threshold_applied,
      runbookId: r.runbook_id,
      runbookTitle: r.runbook_title,
      summary: r.summary,
      detectedAt: r.detected_at,
      version: r.version,
      reviewerId: r.reviewer_id,
      reviewedAt: r.reviewed_at,
      reviewNotes: r.review_notes,
      resolutionAction: r.resolution_action,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })
  )

  return { items, total }
}

export async function getD1AnomalyAlertDetail(
  db: D1Database,
  alertId: string
): Promise<{
  alert: AnomalyAlert
  reviews: AnomalyReview[]
  runbook: AnomalyRunbook
}> {
  const alert = await getD1AnomalyAlert(db, alertId)
  const runbook = getRunbookForDimension(alert.dimension)

  const reviewRows = await db
    .prepare(
      `SELECT id, alert_id, reviewer_id, action, previous_status, new_status, notes, resolution_action, reviewed_at
       FROM anomaly_alert_reviews
       WHERE alert_id = ?
       ORDER BY reviewed_at ASC`
    )
    .bind(alertId)
    .all<Record<string, unknown>>()

  const reviews: AnomalyReview[] = (reviewRows.results ?? []).map((r) => ({
    id: r.id as string,
    alertId: r.alert_id as string,
    reviewerId: r.reviewer_id as string,
    action: r.action as AnomalyReview['action'],
    previousStatus: r.previous_status as string,
    newStatus: r.new_status as string,
    notes: r.notes as string,
    resolutionAction: (r.resolution_action as string | null) ?? null,
    reviewedAt: r.reviewed_at as string
  }))

  return { alert, reviews, runbook }
}

export async function reviewD1AnomalyAlert(
  db: D1Database,
  claims: VerifiedSessionClaims,
  alertId: string,
  input: AnomalyReviewInput,
  options?: AnomalyDetectionOptions
): Promise<{ alert: AnomalyAlert; reviewId: string }> {
  await requireManagePermission(db, claims, options)

  const parsed = anomalyReviewInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const data = parsed.data

  const now = instant(options)
  const currentAlert = await getD1AnomalyAlert(db, alertId)

  if (currentAlert.version !== data.expectedVersion) {
    fail('version_conflict')
  }

  let nextStatus: AnomalyAlert['status']
  switch (data.action) {
    case 'acknowledge':
      nextStatus = 'acknowledged'
      break
    case 'investigate':
      nextStatus = 'under_investigation'
      break
    case 'resolve':
      nextStatus = 'resolved'
      break
    case 'dismiss':
      nextStatus = 'dismissed_false_positive'
      break
    default:
      fail('invalid_input')
  }

  const nextVersion = currentAlert.version + 1
  const reviewId = crypto.randomUUID()

  // Update alert status with CAS
  try {
    await db
      .prepare(
        `UPDATE anomaly_alerts
         SET version = ?, status = ?, reviewer_id = ?, reviewed_at = ?, review_notes = ?, resolution_action = ?, updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        nextVersion,
        nextStatus,
        claims.identityId,
        now,
        data.notes,
        data.resolutionAction ?? null,
        now,
        alertId,
        data.expectedVersion
      )
      .run()
  } catch {
    fail('version_conflict')
  }

  // Insert immutable review audit trail
  await db
    .prepare(
      `INSERT INTO anomaly_alert_reviews
        (id, alert_id, reviewer_id, action, previous_status, new_status, notes, resolution_action, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      reviewId,
      alertId,
      claims.identityId,
      data.action,
      currentAlert.status,
      nextStatus,
      data.notes,
      data.resolutionAction ?? null,
      now
    )
    .run()

  // Log command
  const commandId = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify({ alertId, ...data }))
  await db
    .prepare(
      `INSERT INTO anomaly_commands
        (command_id, actor_id, action, idempotency_key, expected_version, applied_version, payload_hash, input_json, receipt_json, created_at)
       VALUES (?, ?, 'review_alert', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      data.idempotencyKey,
      data.expectedVersion,
      nextVersion,
      payloadHash,
      JSON.stringify(data),
      JSON.stringify({ reviewId, alertId, newStatus: nextStatus }),
      now
    )
    .run()

  const updatedAlert = await getD1AnomalyAlert(db, alertId)
  return { alert: updatedAlert, reviewId }
}
