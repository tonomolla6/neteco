import {
  type CreateSegmentInput,
  type UpdateSegmentRulesInput,
  type AudienceSegmentRecord,
  type AudienceSegmentVersionRecord,
  type AudienceEstimationResult,
  type AudienceUserPreview,
  CreateSegmentInputSchema,
  UpdateSegmentRulesInputSchema,
  AdminAudiencesError,
  maskEmail,
  audiencePayloadHash
} from '../../shared/admin-audiences'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface AudienceOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: { now?: () => string }): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function createD1AudienceSegment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CreateSegmentInput,
  options: AudienceOperationOptions
): Promise<{ segmentId: string; slug: string; version: number }> {
  const parsed = CreateSegmentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AdminAudiencesError('invalid_input', `Entrada de segmento inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await audiencePayloadHash('create_segment', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM audience_segment_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new AdminAudiencesError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Check unique slug
  const existingSlug = await database
    .prepare(`SELECT 1 FROM audience_segments WHERE slug = ?1`)
    .bind(input.slug)
    .first()

  if (existingSlug) {
    throw new AdminAudiencesError('slug_taken', `El slug '${input.slug}' ya está en uso`)
  }

  const segmentId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const receipt = { segmentId, slug: input.slug, version: 1 }

  await database.batch([
    database
      .prepare(
        `INSERT INTO audience_segments (
          id, slug, name, description, version, rules_json, target_type, status,
          estimated_total_users, estimated_consented_users, created_at, updated_at,
          created_by, updated_by
        ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 'active', 0, 0, ?7, ?7, ?8, ?8)`
      )
      .bind(
        segmentId,
        input.slug,
        input.name,
        input.description ?? null,
        JSON.stringify(input.rules),
        input.targetType,
        now,
        claims.identityId
      ),
    database
      .prepare(
        `INSERT INTO audience_segment_versions (
          id, segment_id, version, rules_json, change_summary, created_by, created_at
        ) VALUES (?1, ?2, 1, ?3, 'Versión inicial de reglas', ?4, ?5)`
      )
      .bind(versionId, segmentId, JSON.stringify(input.rules), claims.identityId, now),
    database
      .prepare(
        `INSERT INTO audience_segment_commands (
          command_id, segment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'create_segment', ?4, 0, 1, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        segmentId,
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

export async function updateD1AudienceSegmentRules(
  database: D1Database,
  claims: VerifiedSessionClaims,
  segmentId: string,
  rawInput: UpdateSegmentRulesInput,
  options: AudienceOperationOptions
): Promise<{ segmentId: string; version: number }> {
  const parsed = UpdateSegmentRulesInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new AdminAudiencesError(
      'invalid_input',
      `Entrada de actualización de reglas inválida: ${parsed.error.message}`
    )
  }
  const input = parsed.data
  const now = getIsoNow(options)
  const payloadHash = await audiencePayloadHash('update_rules', input)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM audience_segment_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new AdminAudiencesError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await readD1AudienceSegment(database, segmentId)
  if (!existing) {
    throw new AdminAudiencesError('not_found', `Segmento ${segmentId} no encontrado`)
  }

  if (existing.version !== input.expectedVersion) {
    throw new AdminAudiencesError(
      'concurrency_conflict',
      `Conflicto CAS: versión esperada ${input.expectedVersion}, versión actual ${existing.version}`
    )
  }

  const nextVersion = existing.version + 1
  const nextName = input.name ?? existing.name
  const nextDesc = input.description !== undefined ? input.description : existing.description
  const nextTarget = input.targetType ?? existing.targetType

  const versionId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const receipt = { segmentId, version: nextVersion }

  await database.batch([
    database
      .prepare(
        `UPDATE audience_segments SET
          name = ?1,
          description = ?2,
          target_type = ?3,
          rules_json = ?4,
          version = ?5,
          updated_at = ?6,
          updated_by = ?7
        WHERE id = ?8 AND version = ?9`
      )
      .bind(
        nextName,
        nextDesc,
        nextTarget,
        JSON.stringify(input.rules),
        nextVersion,
        now,
        claims.identityId,
        segmentId,
        existing.version
      ),
    database
      .prepare(
        `INSERT INTO audience_segment_versions (
          id, segment_id, version, rules_json, change_summary, created_by, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        versionId,
        segmentId,
        nextVersion,
        JSON.stringify(input.rules),
        input.changeSummary,
        claims.identityId,
        now
      ),
    database
      .prepare(
        `INSERT INTO audience_segment_commands (
          command_id, segment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'update_rules', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        commandId,
        segmentId,
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

interface RawUserMatch {
  customerId: string
  customerName: string | null
  email: string | null
  isB2b: boolean
  hasActiveConsent: boolean
  orderCount: number
  totalSpentCents: number
  lastOrderDate: string | null
}

async function queryMatchingUsers(database: D1Database, segment: AudienceSegmentRecord): Promise<RawUserMatch[]> {
  // Query customers with their company status, order stats, and newsletter consent
  const rows = await database
    .prepare(
      `SELECT
        c.id as customer_id,
        c.name as customer_name,
        i.email as identity_email,
        (co.id IS NOT NULL) as is_b2b,
        (
          ns.status = 'confirmed' AND nsup.email_hash IS NULL
        ) as has_active_consent,
        COALESCE(ord.order_count, 0) as order_count,
        COALESCE(ord.total_spent_cents, 0) as total_spent_cents,
        ord.last_order_date
      FROM customers c
      LEFT JOIN identities i ON i.customer_id = c.id
      LEFT JOIN companies co ON co.customer_id = c.id
      LEFT JOIN newsletter_subscriptions ns ON (
        (i.email IS NOT NULL AND ns.email_normalized = lower(trim(i.email)))
        OR (c.name IS NOT NULL AND lower(trim(c.name)) LIKE '%@%' AND ns.email_normalized = lower(trim(c.name)))
      )
      LEFT JOIN newsletter_suppressions nsup ON nsup.email_hash = ns.email_hash
      LEFT JOIN (
        SELECT
          customer_id,
          COUNT(*) as order_count,
          SUM(total_gross_cents) as total_spent_cents,
          MAX(created_at) as last_order_date
        FROM orders
        WHERE status != 'cancelled'
        GROUP BY customer_id
      ) ord ON ord.customer_id = c.id
      WHERE c.status = 'active'`
    )
    .all<{
      customer_id: string
      customer_name: string | null
      identity_email: string | null
      is_b2b: number
      has_active_consent: number
      order_count: number
      total_spent_cents: number
      last_order_date: string | null
    }>()

  const allUsers: RawUserMatch[] = (rows.results ?? []).map((r) => {
    // If identity_email is missing, attempt to use customer name or fallback synthetic email
    let email = r.identity_email
    if (!email && r.customer_name && r.customer_name.includes('@')) {
      email = r.customer_name
    } else if (!email) {
      email = `cliente-${r.customer_id.slice(0, 8)}@neteco-buyer.invalid`
    }

    return {
      customerId: r.customer_id,
      customerName: r.customer_name,
      email,
      isB2b: Boolean(r.is_b2b),
      hasActiveConsent: Boolean(r.has_active_consent),
      orderCount: Number(r.order_count),
      totalSpentCents: Number(r.total_spent_cents),
      lastOrderDate: r.last_order_date
    }
  })

  // Filter in-memory based on targetType and segment.rules
  return allUsers.filter((u) => {
    // 1. Target type check
    if (segment.targetType === 'b2b' && !u.isB2b) return false
    if (segment.targetType === 'b2c' && u.isB2b) return false

    // 2. Conditions check
    if (!segment.rules.conditions || segment.rules.conditions.length === 0) {
      return true
    }

    const logic = segment.rules.logic || 'AND'
    const evalCondition = (c: (typeof segment.rules.conditions)[number]): boolean => {
      let actual: unknown
      if (c.field === 'customer_type') actual = u.isB2b ? 'b2b' : 'b2c'
      else if (c.field === 'orders_count') actual = u.orderCount
      else if (c.field === 'total_spent_cents') actual = u.totalSpentCents
      else if (c.field === 'newsletter_consent') actual = u.hasActiveConsent
      else actual = null

      if (c.operator === 'eq') return actual === c.value
      if (c.operator === 'neq') return actual !== c.value
      if (c.operator === 'gt') return Number(actual) > Number(c.value)
      if (c.operator === 'gte') return Number(actual) >= Number(c.value)
      if (c.operator === 'lt') return Number(actual) < Number(c.value)
      if (c.operator === 'lte') return Number(actual) <= Number(c.value)
      if (c.operator === 'in' && Array.isArray(c.value)) return c.value.includes(actual as never)
      return true
    }

    if (logic === 'AND') {
      return segment.rules.conditions.every(evalCondition)
    } else {
      return segment.rules.conditions.some(evalCondition)
    }
  })
}

export async function estimateD1AudienceSegment(
  database: D1Database,
  segmentId: string,
  options?: { now?: () => string }
): Promise<AudienceEstimationResult> {
  const segment = await readD1AudienceSegment(database, segmentId)
  if (!segment) {
    throw new AdminAudiencesError('not_found', `Segmento ${segmentId} no encontrado`)
  }

  const matchingUsers = await queryMatchingUsers(database, segment)
  const totalMatchingUsers = matchingUsers.length
  const consentedUsers = matchingUsers.filter((u) => u.hasActiveConsent).length
  const unconsentedUsers = totalMatchingUsers - consentedUsers
  const consentPercentage = totalMatchingUsers > 0 ? Math.round((consentedUsers / totalMatchingUsers) * 100) : 0
  const now = getIsoNow(options)

  await database
    .prepare(
      `UPDATE audience_segments SET
        last_estimated_at = ?1,
        estimated_total_users = ?2,
        estimated_consented_users = ?3,
        updated_at = ?1
      WHERE id = ?4`
    )
    .bind(now, totalMatchingUsers, consentedUsers, segmentId)
    .run()

  return {
    totalMatchingUsers,
    consentedUsers,
    unconsentedUsers,
    consentPercentage,
    estimatedAt: now
  }
}

export async function previewD1AudienceUsers(
  database: D1Database,
  segmentId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ items: AudienceUserPreview[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const offset = Math.max(options.offset ?? 0, 0)

  const segment = await readD1AudienceSegment(database, segmentId)
  if (!segment) {
    throw new AdminAudiencesError('not_found', `Segmento ${segmentId} no encontrado`)
  }

  const matching = await queryMatchingUsers(database, segment)
  const total = matching.length
  const page = matching.slice(offset, offset + limit)

  // Strictly mask PII: no plaintext email, no full street address, no phone, no tax credentials!
  const items: AudienceUserPreview[] = page.map((u) => {
    let daysSinceLastOrder: number | null = null
    if (u.lastOrderDate) {
      const ms = Date.now() - Date.parse(u.lastOrderDate)
      daysSinceLastOrder = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
    }

    return {
      id: u.customerId,
      maskedIdentifier: maskEmail(u.email ?? 'anonimo@neteco.invalid'),
      customerType: u.isB2b ? 'b2b' : 'b2c',
      hasConsent: u.hasActiveConsent,
      orderCount: u.orderCount,
      totalSpentCents: u.totalSpentCents,
      daysSinceLastOrder
    }
  })

  return { items, total }
}

export async function readD1AudienceSegment(
  database: D1Database,
  segmentId: string
): Promise<AudienceSegmentRecord | null> {
  const row = await database
    .prepare(
      `SELECT
        id, slug, name, description, version, rules_json, target_type, status,
        last_estimated_at, estimated_total_users, estimated_consented_users,
        created_at, updated_at, created_by, updated_by
      FROM audience_segments
      WHERE id = ?1`
    )
    .bind(segmentId)
    .first<{
      id: string
      slug: string
      name: string
      description: string | null
      version: number
      rules_json: string
      target_type: string
      status: string
      last_estimated_at: string | null
      estimated_total_users: number
      estimated_consented_users: number
      created_at: string
      updated_at: string
      created_by: string
      updated_by: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    rules: JSON.parse(row.rules_json),
    targetType: row.target_type as AudienceSegmentRecord['targetType'],
    status: row.status as AudienceSegmentRecord['status'],
    lastEstimatedAt: row.last_estimated_at,
    estimatedTotalUsers: row.estimated_total_users,
    estimatedConsentedUsers: row.estimated_consented_users,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  }
}

export async function listD1AudienceSegments(
  database: D1Database,
  filters: { status?: string; limit?: number; offset?: number } = {}
): Promise<{ items: AudienceSegmentRecord[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (filters.status) {
    params.push(filters.status)
    where += ` AND status = ?${params.length}`
  }

  const countRow = await database
    .prepare(`SELECT COUNT(*) as total FROM audience_segments ${where}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countRow?.total ?? 0

  params.push(limit, offset)
  const rows = await database
    .prepare(
      `SELECT
        id, slug, name, description, version, rules_json, target_type, status,
        last_estimated_at, estimated_total_users, estimated_consented_users,
        created_at, updated_at, created_by, updated_by
      FROM audience_segments
      ${where}
      ORDER BY created_at DESC
      LIMIT ?${params.length - 1} OFFSET ?${params.length}`
    )
    .bind(...params)
    .all<{
      id: string
      slug: string
      name: string
      description: string | null
      version: number
      rules_json: string
      target_type: string
      status: string
      last_estimated_at: string | null
      estimated_total_users: number
      estimated_consented_users: number
      created_at: string
      updated_at: string
      created_by: string
      updated_by: string
    }>()

  const items: AudienceSegmentRecord[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    rules: JSON.parse(row.rules_json),
    targetType: row.target_type as AudienceSegmentRecord['targetType'],
    status: row.status as AudienceSegmentRecord['status'],
    lastEstimatedAt: row.last_estimated_at,
    estimatedTotalUsers: row.estimated_total_users,
    estimatedConsentedUsers: row.estimated_consented_users,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by
  }))

  return { items, total }
}

export async function listD1AudienceSegmentVersions(
  database: D1Database,
  segmentId: string
): Promise<AudienceSegmentVersionRecord[]> {
  const rows = await database
    .prepare(
      `SELECT id, segment_id, version, rules_json, change_summary, created_by, created_at
       FROM audience_segment_versions
       WHERE segment_id = ?1
       ORDER BY version ASC`
    )
    .bind(segmentId)
    .all<{
      id: string
      segment_id: string
      version: number
      rules_json: string
      change_summary: string
      created_by: string
      created_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    segmentId: r.segment_id,
    version: r.version,
    rules: JSON.parse(r.rules_json),
    changeSummary: r.change_summary,
    createdBy: r.created_by,
    createdAt: r.created_at
  }))
}
