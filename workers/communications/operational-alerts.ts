import { z } from 'zod'
import {
  type OperationalAlert,
  type OperationalAlertDispatch,
  operationalAlertInputSchema,
  operationalAlertAckInputSchema,
  operationalAlertEscalateInputSchema,
  operationalAlertResolveInputSchema,
  operationalAlertListQuerySchema,
  operationalAlertIntentHash
} from '../../shared/operational-alerts'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export type OperationalAlertsErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'unapproved_channel'
  | 'service_unavailable'

export class OperationalAlertsError extends Error {
  constructor(readonly code: OperationalAlertsErrorCode) {
    super(code)
    this.name = 'OperationalAlertsError'
  }
}

function fail(code: OperationalAlertsErrorCode): never {
  throw new OperationalAlertsError(code)
}

export interface OperationalAlertOptions {
  now?: () => string
}

function currentInstant(options?: OperationalAlertOptions): string {
  return options?.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface AlertRow {
  id: string
  area: string
  severity: string
  category: string
  title: string
  description: string
  location_ref: string
  status: string
  escalation_tier: number
  redundant_channel_required: number
  redundant_channel_dispatched: number
  version: number
  acknowledged_at: string | null
  acknowledged_by: string | null
  ack_note: string | null
  escalated_at: string | null
  escalation_reason: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
  created_at: string
  created_by: string
}

interface DispatchRow {
  id: string
  alert_id: string
  channel: string
  is_redundant: number
  recipient_target: string
  status: string
  dispatched_at: string
}

function mapAlert(row: AlertRow, dispatches: DispatchRow[] = []): OperationalAlert {
  return {
    id: row.id,
    area: row.area as OperationalAlert['area'],
    severity: row.severity as OperationalAlert['severity'],
    category: row.category as OperationalAlert['category'],
    title: row.title,
    description: row.description,
    locationRef: row.location_ref,
    status: row.status as OperationalAlert['status'],
    escalationTier: row.escalation_tier,
    redundantChannelRequired: row.redundant_channel_required === 1,
    redundantChannelDispatched: row.redundant_channel_dispatched === 1,
    version: row.version,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    ackNote: row.ack_note,
    escalatedAt: row.escalated_at,
    escalationReason: row.escalation_reason,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    createdBy: row.created_by,
    dispatches: dispatches.map((d) => ({
      id: d.id,
      alertId: d.alert_id,
      channel: d.channel as OperationalAlertDispatch['channel'],
      isRedundant: d.is_redundant === 1,
      recipientTarget: d.recipient_target,
      status: d.status as OperationalAlertDispatch['status'],
      dispatchedAt: d.dispatched_at
    }))
  }
}

async function verifyAuth(db: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) fail('unauthenticated')
  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: false })
  if (!auth.allowed) fail(auth.code)
  return auth
}

export async function createD1OperationalAlert(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  alertId: string,
  commandId: string,
  rawInput: unknown,
  options?: OperationalAlertOptions
): Promise<OperationalAlert> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  // Rejection of un-auditable personal channels (COM-019 acceptance criterion)
  if (rawInput && typeof rawInput === 'object') {
    const raw = rawInput as Record<string, unknown>
    if (
      'unapprovedChannel' in raw ||
      ('channel' in raw &&
        !['dashboard', 'warehouse_terminal', 'sms_pager', 'redundant_webhook'].includes(String(raw.channel)))
    ) {
      fail('invalid_input')
    }
  }

  const parsed = operationalAlertInputSchema.safeParse(rawInput)
  if (
    !parsed.success ||
    !z.string().uuid().safeParse(alertId).success ||
    !z.string().uuid().safeParse(commandId).success
  ) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await operationalAlertIntentHash('create', alertId, input)

  // Idempotency check
  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM operational_alert_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return JSON.parse(existingCommand.receipt_json) as OperationalAlert
  }

  const isCritical = input.severity === 'critical'
  const redundantRequired = isCritical ? 1 : 0
  const redundantDispatched = isCritical ? 1 : 0

  const primaryDispatchId = crypto.randomUUID()
  const redundantDispatchId = crypto.randomUUID()

  const dispatchesToInsert: DispatchRow[] = [
    {
      id: primaryDispatchId,
      alert_id: alertId,
      channel: 'dashboard',
      is_redundant: 0,
      recipient_target: `ops-${input.area}@neteco.local`,
      status: 'dispatched',
      dispatched_at: now
    }
  ]

  if (isCritical) {
    dispatchesToInsert.push({
      id: redundantDispatchId,
      alert_id: alertId,
      channel: 'sms_pager',
      is_redundant: 1,
      recipient_target: '+34600998877-ops-pager',
      status: 'dispatched',
      dispatched_at: now
    })
  }

  const alertRow: AlertRow = {
    id: alertId,
    area: input.area,
    severity: input.severity,
    category: input.category,
    title: input.title,
    description: input.description,
    location_ref: input.locationRef,
    status: 'open',
    escalation_tier: 1,
    redundant_channel_required: redundantRequired,
    redundant_channel_dispatched: redundantDispatched,
    version: 1,
    acknowledged_at: null,
    acknowledged_by: null,
    ack_note: null,
    escalated_at: null,
    escalation_reason: null,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: now,
    created_by: auth.identityId
  }

  const resultAlert = mapAlert(alertRow, dispatchesToInsert)

  const statements = [
    db
      .prepare(
        `INSERT INTO operational_alerts (
          id, area, severity, category, title, description, location_ref, status,
          escalation_tier, redundant_channel_required, redundant_channel_dispatched,
          version, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        alertRow.id,
        alertRow.area,
        alertRow.severity,
        alertRow.category,
        alertRow.title,
        alertRow.description,
        alertRow.location_ref,
        alertRow.status,
        alertRow.escalation_tier,
        alertRow.redundant_channel_required,
        alertRow.redundant_channel_dispatched,
        alertRow.version,
        alertRow.created_at,
        alertRow.created_by
      ),
    ...dispatchesToInsert.map((d) =>
      db
        .prepare(
          `INSERT INTO operational_alert_dispatches (
            id, alert_id, channel, is_redundant, recipient_target, status, dispatched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(d.id, d.alert_id, d.channel, d.is_redundant, d.recipient_target, d.status, d.dispatched_at)
    ),
    db
      .prepare(
        `INSERT INTO operational_alert_commands (
          command_id, actor_id, alert_id, action, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        alertId,
        'create',
        0,
        1,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(resultAlert),
        now
      )
  ]

  await db.batch(statements)
  return resultAlert
}

export async function acknowledgeD1OperationalAlert(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  alertId: string,
  commandId: string,
  rawInput: unknown,
  options?: OperationalAlertOptions
): Promise<OperationalAlert> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const parsed = operationalAlertAckInputSchema.safeParse(rawInput)
  if (
    !parsed.success ||
    !z.string().uuid().safeParse(alertId).success ||
    !z.string().uuid().safeParse(commandId).success
  ) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await operationalAlertIntentHash('acknowledge', alertId, input)

  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM operational_alert_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(existingCommand.receipt_json) as OperationalAlert
  }

  const alert = await db.prepare('SELECT * FROM operational_alerts WHERE id = ?').bind(alertId).first<AlertRow>()

  if (!alert) fail('not_found')
  if (alert.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = alert.version + 1

  const updatedRow: AlertRow = {
    ...alert,
    status: 'acknowledged',
    version: nextVersion,
    acknowledged_at: now,
    acknowledged_by: auth.identityId,
    ack_note: input.ackNote
  }

  const dispatches = await db
    .prepare('SELECT * FROM operational_alert_dispatches WHERE alert_id = ? ORDER BY dispatched_at ASC')
    .bind(alertId)
    .all<DispatchRow>()

  const resultAlert = mapAlert(updatedRow, dispatches.results ?? [])

  await db.batch([
    db
      .prepare(
        `UPDATE operational_alerts
         SET status = 'acknowledged', version = ?, acknowledged_at = ?, acknowledged_by = ?, ack_note = ?
         WHERE id = ? AND version = ?`
      )
      .bind(nextVersion, now, auth.identityId, input.ackNote, alertId, alert.version),
    db
      .prepare(
        `INSERT INTO operational_alert_commands (
          command_id, actor_id, alert_id, action, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        alertId,
        'acknowledge',
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(resultAlert),
        now
      )
  ])

  return resultAlert
}

export async function escalateD1OperationalAlert(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  alertId: string,
  commandId: string,
  rawInput: unknown,
  options?: OperationalAlertOptions
): Promise<OperationalAlert> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const parsed = operationalAlertEscalateInputSchema.safeParse(rawInput)
  if (
    !parsed.success ||
    !z.string().uuid().safeParse(alertId).success ||
    !z.string().uuid().safeParse(commandId).success
  ) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await operationalAlertIntentHash('escalate', alertId, input)

  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM operational_alert_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(existingCommand.receipt_json) as OperationalAlert
  }

  const alert = await db.prepare('SELECT * FROM operational_alerts WHERE id = ?').bind(alertId).first<AlertRow>()

  if (!alert) fail('not_found')
  if (alert.version !== input.expectedVersion) fail('version_conflict')
  if (input.targetTier <= alert.escalation_tier) fail('invalid_input')

  const nextVersion = alert.version + 1
  const escalationDispatchId = crypto.randomUUID()

  const escalationDispatch: DispatchRow = {
    id: escalationDispatchId,
    alert_id: alertId,
    channel: 'sms_pager',
    is_redundant: 1,
    recipient_target: `tier-${input.targetTier}-supervisor-pager`,
    status: 'dispatched',
    dispatched_at: now
  }

  const updatedRow: AlertRow = {
    ...alert,
    status: 'escalated',
    escalation_tier: input.targetTier,
    version: nextVersion,
    escalated_at: now,
    escalation_reason: input.escalationReason
  }

  const prevDispatches = await db
    .prepare('SELECT * FROM operational_alert_dispatches WHERE alert_id = ? ORDER BY dispatched_at ASC')
    .bind(alertId)
    .all<DispatchRow>()

  const allDispatches = [...(prevDispatches.results ?? []), escalationDispatch]
  const resultAlert = mapAlert(updatedRow, allDispatches)

  await db.batch([
    db
      .prepare(
        `UPDATE operational_alerts
         SET status = 'escalated', escalation_tier = ?, version = ?, escalated_at = ?, escalation_reason = ?
         WHERE id = ? AND version = ?`
      )
      .bind(input.targetTier, nextVersion, now, input.escalationReason, alertId, alert.version),
    db
      .prepare(
        `INSERT INTO operational_alert_dispatches (
          id, alert_id, channel, is_redundant, recipient_target, status, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        escalationDispatch.id,
        escalationDispatch.alert_id,
        escalationDispatch.channel,
        escalationDispatch.is_redundant,
        escalationDispatch.recipient_target,
        escalationDispatch.status,
        escalationDispatch.dispatched_at
      ),
    db
      .prepare(
        `INSERT INTO operational_alert_commands (
          command_id, actor_id, alert_id, action, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        alertId,
        'escalate',
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(resultAlert),
        now
      )
  ])

  return resultAlert
}

export async function resolveD1OperationalAlert(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  alertId: string,
  commandId: string,
  rawInput: unknown,
  options?: OperationalAlertOptions
): Promise<OperationalAlert> {
  const now = currentInstant(options)
  const auth = await verifyAuth(db, claims, now)

  const parsed = operationalAlertResolveInputSchema.safeParse(rawInput)
  if (
    !parsed.success ||
    !z.string().uuid().safeParse(alertId).success ||
    !z.string().uuid().safeParse(commandId).success
  ) {
    fail('invalid_input')
  }
  const input = parsed.data

  const payloadHash = await operationalAlertIntentHash('resolve', alertId, input)

  const existingCommand = await db
    .prepare('SELECT receipt_json, payload_hash FROM operational_alert_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ receipt_json: string; payload_hash: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(existingCommand.receipt_json) as OperationalAlert
  }

  const alert = await db.prepare('SELECT * FROM operational_alerts WHERE id = ?').bind(alertId).first<AlertRow>()

  if (!alert) fail('not_found')
  if (alert.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = alert.version + 1

  const updatedRow: AlertRow = {
    ...alert,
    status: 'resolved',
    version: nextVersion,
    resolved_at: now,
    resolved_by: auth.identityId,
    resolution_note: input.resolutionNote
  }

  const dispatches = await db
    .prepare('SELECT * FROM operational_alert_dispatches WHERE alert_id = ? ORDER BY dispatched_at ASC')
    .bind(alertId)
    .all<DispatchRow>()

  const resultAlert = mapAlert(updatedRow, dispatches.results ?? [])

  await db.batch([
    db
      .prepare(
        `UPDATE operational_alerts
         SET status = 'resolved', version = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?
         WHERE id = ? AND version = ?`
      )
      .bind(nextVersion, now, auth.identityId, input.resolutionNote, alertId, alert.version),
    db
      .prepare(
        `INSERT INTO operational_alert_commands (
          command_id, actor_id, alert_id, action, expected_version, applied_version,
          payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        auth.identityId,
        alertId,
        'resolve',
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(resultAlert),
        now
      )
  ])

  return resultAlert
}

export async function getD1OperationalAlert(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  alertId: string
): Promise<OperationalAlert> {
  await verifyAuth(db, claims, currentInstant())

  const alert = await db.prepare('SELECT * FROM operational_alerts WHERE id = ?').bind(alertId).first<AlertRow>()

  if (!alert) fail('not_found')

  const dispatches = await db
    .prepare('SELECT * FROM operational_alert_dispatches WHERE alert_id = ? ORDER BY dispatched_at ASC')
    .bind(alertId)
    .all<DispatchRow>()

  return mapAlert(alert, dispatches.results ?? [])
}

export async function listD1OperationalAlerts(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawQuery: unknown
): Promise<{ items: OperationalAlert[]; total: number; page: number; perPage: number }> {
  await verifyAuth(db, claims, currentInstant())

  const parsed = operationalAlertListQuerySchema.safeParse(rawQuery ?? {})
  if (!parsed.success) fail('invalid_input')
  const query = parsed.data

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (query.status) {
    conditions.push('status = ?')
    bindings.push(query.status)
  }
  if (query.severity) {
    conditions.push('severity = ?')
    bindings.push(query.severity)
  }
  if (query.area) {
    conditions.push('area = ?')
    bindings.push(query.area)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const countRow = await db
    .prepare(`SELECT count(*) as count FROM operational_alerts ${whereClause}`)
    .bind(...bindings)
    .first<{ count: number }>()

  const total = countRow?.count ?? 0
  const offset = (query.page - 1) * query.perPage

  const alerts = await db
    .prepare(`SELECT * FROM operational_alerts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, query.perPage, offset)
    .all<AlertRow>()

  const alertIds = (alerts.results ?? []).map((a) => a.id)
  let allDispatches: DispatchRow[] = []
  if (alertIds.length) {
    const placeholders = alertIds.map(() => '?').join(',')
    const dispatchRows = await db
      .prepare(
        `SELECT * FROM operational_alert_dispatches WHERE alert_id IN (${placeholders}) ORDER BY dispatched_at ASC`
      )
      .bind(...alertIds)
      .all<DispatchRow>()
    allDispatches = dispatchRows.results ?? []
  }

  const items = (alerts.results ?? []).map((row) => {
    const rowDispatches = allDispatches.filter((d) => d.alert_id === row.id)
    return mapAlert(row, rowDispatches)
  })

  return { items, total, page: query.page, perPage: query.perPage }
}
