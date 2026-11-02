import {
  type CreateRcaInput,
  type UpdateRcaInput,
  type VerifyRcaInput,
  type SupportRcaRecord,
  CreateRcaInputSchema,
  UpdateRcaInputSchema,
  VerifyRcaInputSchema,
  SupportRcaError,
  rcaPayloadHash
} from '../../shared/support-rca'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface RcaOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: RcaOperationOptions): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function createD1SupportRca(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options: RcaOperationOptions
): Promise<{ rcaId: string; publicRef: string; version: number; status: string }> {
  const parsed = CreateRcaInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportRcaError('invalid_input', `Entrada RCA inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await rcaPayloadHash('create_rca', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_operational_rca_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportRcaError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const rcaId = crypto.randomUUID()
  const publicRef = 'RCA-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()
  const status = input.preventiveActions.length > 0 ? 'action_planned' : 'draft'
  const commandId = crypto.randomUUID()
  const receipt = { rcaId, publicRef, version: 1, status }

  await database.batch([
    database
      .prepare(
        `INSERT INTO support_operational_rcas (
          id, public_ref, incident_category, ticket_id, order_id, title,
          status, severity, root_cause_summary, five_whys_json, preventive_actions_json,
          verification_status, version, created_at, updated_at, created_by
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'unverified', 1, ?12, ?12, ?13)`
      )
      .bind(
        rcaId,
        publicRef,
        input.incidentCategory,
        input.ticketId ?? null,
        input.orderId ?? null,
        input.title,
        status,
        input.severity,
        input.rootCauseSummary,
        JSON.stringify(input.fiveWhys),
        JSON.stringify(input.preventiveActions),
        now,
        claims.identityId
      ),
    database
      .prepare(
        `INSERT INTO support_operational_rca_commands (
          command_id, rca_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'create_rca', ?4, 0, 1, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        rcaId,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function updateD1SupportRca(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rcaId: string,
  rawInput: unknown,
  options: RcaOperationOptions
): Promise<{ rcaId: string; version: number; status: string }> {
  const parsed = UpdateRcaInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportRcaError('invalid_input', `Entrada de actualización RCA inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await rcaPayloadHash('update_investigation', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_operational_rca_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportRcaError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await readD1SupportRca(database, rcaId)
  if (!existing) {
    throw new SupportRcaError('not_found', `RCA con id ${rcaId} no encontrado`)
  }

  if (existing.version !== input.expectedVersion) {
    throw new SupportRcaError(
      'concurrency_conflict',
      `Conflicto CAS: versión esperada ${input.expectedVersion}, versión actual ${existing.version}`
    )
  }

  const nextVersion = existing.version + 1
  const nextStatus = input.status ?? existing.status
  const nextSeverity = input.severity ?? existing.severity
  const nextSummary = input.rootCauseSummary ?? existing.rootCauseSummary
  const nextFiveWhys = input.fiveWhys ?? existing.fiveWhys
  const nextActions = input.preventiveActions ?? existing.preventiveActions

  const commandId = crypto.randomUUID()
  const receipt = { rcaId, version: nextVersion, status: nextStatus }

  await database.batch([
    database
      .prepare(
        `UPDATE support_operational_rcas SET
          status = ?1,
          severity = ?2,
          root_cause_summary = ?3,
          five_whys_json = ?4,
          preventive_actions_json = ?5,
          version = ?6,
          updated_at = ?7
        WHERE id = ?8 AND version = ?9`
      )
      .bind(
        nextStatus,
        nextSeverity,
        nextSummary,
        JSON.stringify(nextFiveWhys),
        JSON.stringify(nextActions),
        nextVersion,
        now,
        rcaId,
        existing.version
      ),
    database
      .prepare(
        `INSERT INTO support_operational_rca_commands (
          command_id, rca_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'update_investigation', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        commandId,
        rcaId,
        claims.identityId,
        options.idempotencyKey,
        existing.version,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function verifyD1SupportRca(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rcaId: string,
  rawInput: unknown,
  options: RcaOperationOptions
): Promise<{ rcaId: string; version: number; verificationStatus: string; status: string }> {
  const parsed = VerifyRcaInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SupportRcaError('invalid_input', `Entrada de verificación RCA inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await rcaPayloadHash('verify_effectiveness', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM support_operational_rca_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new SupportRcaError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await readD1SupportRca(database, rcaId)
  if (!existing) {
    throw new SupportRcaError('not_found', `RCA con id ${rcaId} no encontrado`)
  }

  if (existing.version !== input.expectedVersion) {
    throw new SupportRcaError(
      'concurrency_conflict',
      `Conflicto CAS: versión esperada ${input.expectedVersion}, versión actual ${existing.version}`
    )
  }

  const nextVersion = existing.version + 1
  const nextStatus = input.verificationStatus === 'verified_effective' ? 'verified' : 'investigating'
  const commandId = crypto.randomUUID()
  const receipt = {
    rcaId,
    version: nextVersion,
    verificationStatus: input.verificationStatus,
    status: nextStatus
  }

  await database.batch([
    database
      .prepare(
        `UPDATE support_operational_rcas SET
          verification_status = ?1,
          verified_at = ?2,
          verified_by = ?3,
          verification_notes = ?4,
          status = ?5,
          version = ?6,
          updated_at = ?7
        WHERE id = ?8 AND version = ?9`
      )
      .bind(
        input.verificationStatus,
        now,
        claims.identityId,
        input.verificationNotes,
        nextStatus,
        nextVersion,
        now,
        rcaId,
        existing.version
      ),
    database
      .prepare(
        `INSERT INTO support_operational_rca_commands (
          command_id, rca_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'verify_effectiveness', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        commandId,
        rcaId,
        claims.identityId,
        options.idempotencyKey,
        existing.version,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function readD1SupportRca(database: D1Database, rcaId: string): Promise<SupportRcaRecord | null> {
  const row = await database
    .prepare(
      `SELECT
        id, public_ref, incident_category, ticket_id, order_id, title,
        status, severity, root_cause_summary, five_whys_json, preventive_actions_json,
        verification_status, verified_at, verified_by, verification_notes,
        version, created_at, updated_at, created_by
      FROM support_operational_rcas
      WHERE id = ?1`
    )
    .bind(rcaId)
    .first<{
      id: string
      public_ref: string
      incident_category: string
      ticket_id: string | null
      order_id: string | null
      title: string
      status: string
      severity: string
      root_cause_summary: string
      five_whys_json: string
      preventive_actions_json: string
      verification_status: string
      verified_at: string | null
      verified_by: string | null
      verification_notes: string | null
      version: number
      created_at: string
      updated_at: string
      created_by: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    publicRef: row.public_ref,
    incidentCategory: row.incident_category as SupportRcaRecord['incidentCategory'],
    ticketId: row.ticket_id,
    orderId: row.order_id,
    title: row.title,
    status: row.status as SupportRcaRecord['status'],
    severity: row.severity as SupportRcaRecord['severity'],
    rootCauseSummary: row.root_cause_summary,
    fiveWhys: JSON.parse(row.five_whys_json),
    preventiveActions: JSON.parse(row.preventive_actions_json),
    verificationStatus: row.verification_status as SupportRcaRecord['verificationStatus'],
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    verificationNotes: row.verification_notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

export async function listD1SupportRcas(
  database: D1Database,
  filters: { category?: string; status?: string; limit?: number; offset?: number } = {}
): Promise<{ items: SupportRcaRecord[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (filters.category) {
    params.push(filters.category)
    where += ` AND incident_category = ?${params.length}`
  }
  if (filters.status) {
    params.push(filters.status)
    where += ` AND status = ?${params.length}`
  }

  const countRow = await database
    .prepare(`SELECT COUNT(*) as total FROM support_operational_rcas ${where}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countRow?.total ?? 0

  params.push(limit, offset)
  const rows = await database
    .prepare(
      `SELECT
        id, public_ref, incident_category, ticket_id, order_id, title,
        status, severity, root_cause_summary, five_whys_json, preventive_actions_json,
        verification_status, verified_at, verified_by, verification_notes,
        version, created_at, updated_at, created_by
      FROM support_operational_rcas
      ${where}
      ORDER BY created_at DESC
      LIMIT ?${params.length - 1} OFFSET ?${params.length}`
    )
    .bind(...params)
    .all<{
      id: string
      public_ref: string
      incident_category: string
      ticket_id: string | null
      order_id: string | null
      title: string
      status: string
      severity: string
      root_cause_summary: string
      five_whys_json: string
      preventive_actions_json: string
      verification_status: string
      verified_at: string | null
      verified_by: string | null
      verification_notes: string | null
      version: number
      created_at: string
      updated_at: string
      created_by: string
    }>()

  const items: SupportRcaRecord[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    publicRef: row.public_ref,
    incidentCategory: row.incident_category as SupportRcaRecord['incidentCategory'],
    ticketId: row.ticket_id,
    orderId: row.order_id,
    title: row.title,
    status: row.status as SupportRcaRecord['status'],
    severity: row.severity as SupportRcaRecord['severity'],
    rootCauseSummary: row.root_cause_summary,
    fiveWhys: JSON.parse(row.five_whys_json),
    preventiveActions: JSON.parse(row.preventive_actions_json),
    verificationStatus: row.verification_status as SupportRcaRecord['verificationStatus'],
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    verificationNotes: row.verification_notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }))

  return { items, total }
}
