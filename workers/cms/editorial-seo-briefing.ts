import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type EditorialBriefing,
  type UnifiedEditorialCalendar,
  createEditorialBriefingInputSchema,
  updateEditorialBriefingInputSchema,
  reviewEditorialBriefingInputSchema,
  publishOrScheduleEditorialBriefingInputSchema
} from '../../shared/editorial-seo-briefing'

export class EditorialBriefingError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'EditorialBriefingError'
  }
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function authorizeAdmin(database: D1Database, claims: VerifiedSessionClaims, now?: string): Promise<void> {
  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  const resWrite = await authorizeD1Session(database, claims, 'catalog.write', {
    now,
    requireMfa: true
  })
  if (resWrite.allowed) return

  if (resManage.code === 'unauthenticated' || resWrite.code === 'unauthenticated') {
    throw new EditorialBriefingError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new EditorialBriefingError('forbidden', 'Requires administration.manage or catalog.write permission')
}

interface EditorialBriefingRow {
  id: string
  page_id: string | null
  topic: string
  search_intent: 'informational' | 'commercial' | 'transactional' | 'navigational'
  target_keyword: string
  secondary_keywords_json: string
  expert_author_json: string
  sources_json: string
  assets_json: string
  review_status: 'pending' | 'in_review' | 'approved' | 'rejected'
  review_notes: string | null
  reviewer_identity_id: string | null
  target_publish_date: string
  actual_published_at: string | null
  update_cadence_months: number | null
  last_reviewed_at: string | null
  kpi_targets_json: string
  status: 'planned' | 'drafting' | 'in_review' | 'scheduled' | 'published' | 'needs_update' | 'archived'
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

function parseRow(row: EditorialBriefingRow): EditorialBriefing {
  return {
    id: row.id,
    pageId: row.page_id ?? null,
    topic: row.topic,
    searchIntent: row.search_intent,
    targetKeyword: row.target_keyword,
    secondaryKeywords: JSON.parse(row.secondary_keywords_json || '[]'),
    expertAuthor: JSON.parse(row.expert_author_json || '{}'),
    sources: JSON.parse(row.sources_json || '[]'),
    assets: JSON.parse(row.assets_json || '[]'),
    reviewStatus: row.review_status,
    reviewNotes: row.review_notes ?? null,
    reviewerIdentityId: row.reviewer_identity_id ?? null,
    targetPublishDate: row.target_publish_date,
    actualPublishedAt: row.actual_published_at ?? null,
    updateCadenceMonths: row.update_cadence_months ?? null,
    lastReviewedAt: row.last_reviewed_at ?? null,
    kpiTargets: JSON.parse(row.kpi_targets_json || '{}'),
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createEditorialBriefing(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<EditorialBriefing> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeAdmin(database, claims, now)

  const parsed = createEditorialBriefingInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new EditorialBriefingError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  // Idempotency check
  const existingCmd = await database
    .prepare('SELECT briefing_id FROM editorial_seo_briefing_commands WHERE actor_id = ? AND command_id = ?')
    .bind(claims.identityId, commandId)
    .first<{ briefing_id: string }>()

  if (existingCmd) {
    const existing = await readEditorialBriefing(database, claims, existingCmd.briefing_id, now)
    return existing
  }

  const id = crypto.randomUUID()
  const version = 1
  const status = 'planned'
  const reviewStatus = 'pending'

  await database.batch([
    database
      .prepare(
        `INSERT INTO editorial_seo_briefings (
          id, page_id, topic, search_intent, target_keyword, secondary_keywords_json,
          expert_author_json, sources_json, assets_json, review_status, review_notes,
          reviewer_identity_id, target_publish_date, actual_published_at, update_cadence_months,
          last_reviewed_at, kpi_targets_json, status, version, created_by, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11, NULL, ?12, NULL, ?13, ?14, ?15, ?16, ?17, ?17
        )`
      )
      .bind(
        id,
        data.pageId ?? null,
        data.topic,
        data.searchIntent,
        data.targetKeyword,
        JSON.stringify(data.secondaryKeywords),
        JSON.stringify(data.expertAuthor),
        JSON.stringify(data.sources),
        JSON.stringify(data.assets),
        reviewStatus,
        data.targetPublishDate,
        data.updateCadenceMonths,
        JSON.stringify(data.kpiTargets),
        status,
        version,
        claims.identityId,
        now
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_commands (
          command_id, briefing_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'create', 0, 1, ?4, ?5, ?6)`
      )
      .bind(commandId, id, claims.identityId, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_audit (
          command_id, actor_id, briefing_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'create', ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, id, payloadHash, JSON.stringify(data), now)
  ])

  return readEditorialBriefing(database, claims, id, now)
}

export async function updateEditorialBriefing(
  database: D1Database,
  claims: VerifiedSessionClaims,
  briefingId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<EditorialBriefing> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeAdmin(database, claims, now)

  const parsed = updateEditorialBriefingInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new EditorialBriefingError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const current = await database
    .prepare('SELECT version FROM editorial_seo_briefings WHERE id = ?')
    .bind(briefingId)
    .first<{ version: number }>()

  if (!current) {
    throw new EditorialBriefingError('not_found', 'Briefing not found')
  }

  if (current.version !== data.expectedVersion) {
    throw new EditorialBriefingError(
      'version_conflict',
      `Expected version ${data.expectedVersion} but found ${current.version}`
    )
  }

  const resultVersion = current.version + 1

  await database.batch([
    database
      .prepare(
        `UPDATE editorial_seo_briefings SET
          topic = ?1, search_intent = ?2, target_keyword = ?3, secondary_keywords_json = ?4,
          expert_author_json = ?5, sources_json = ?6, assets_json = ?7, target_publish_date = ?8,
          update_cadence_months = ?9, kpi_targets_json = ?10, version = ?11, updated_at = ?12
        WHERE id = ?13 AND version = ?14`
      )
      .bind(
        data.topic,
        data.searchIntent,
        data.targetKeyword,
        JSON.stringify(data.secondaryKeywords),
        JSON.stringify(data.expertAuthor),
        JSON.stringify(data.sources),
        JSON.stringify(data.assets),
        data.targetPublishDate,
        data.updateCadenceMonths,
        JSON.stringify(data.kpiTargets),
        resultVersion,
        now,
        briefingId,
        data.expectedVersion
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_commands (
          command_id, briefing_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'update', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        briefingId,
        claims.identityId,
        data.expectedVersion,
        resultVersion,
        payloadHash,
        JSON.stringify(data),
        now
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_audit (
          command_id, actor_id, briefing_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'update', ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, briefingId, payloadHash, JSON.stringify(data), now)
  ])

  return readEditorialBriefing(database, claims, briefingId, now)
}

export async function reviewEditorialBriefing(
  database: D1Database,
  claims: VerifiedSessionClaims,
  briefingId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<EditorialBriefing> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeAdmin(database, claims, now)

  const parsed = reviewEditorialBriefingInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new EditorialBriefingError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const current = await database
    .prepare('SELECT version FROM editorial_seo_briefings WHERE id = ?')
    .bind(briefingId)
    .first<{ version: number }>()

  if (!current) {
    throw new EditorialBriefingError('not_found', 'Briefing not found')
  }

  if (current.version !== data.expectedVersion) {
    throw new EditorialBriefingError(
      'version_conflict',
      `Expected version ${data.expectedVersion} but found ${current.version}`
    )
  }

  const resultVersion = current.version + 1

  await database.batch([
    database
      .prepare(
        `UPDATE editorial_seo_briefings SET
          review_status = ?1, review_notes = ?2, reviewer_identity_id = ?3, last_reviewed_at = ?4,
          version = ?5, updated_at = ?4
        WHERE id = ?6 AND version = ?7`
      )
      .bind(
        data.reviewStatus,
        data.reviewNotes ?? null,
        claims.identityId,
        now,
        resultVersion,
        briefingId,
        data.expectedVersion
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_commands (
          command_id, briefing_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'review', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        briefingId,
        claims.identityId,
        data.expectedVersion,
        resultVersion,
        payloadHash,
        JSON.stringify(data),
        now
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_audit (
          command_id, actor_id, briefing_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'review', ?4, ?5, ?6)`
      )
      .bind(commandId, claims.identityId, briefingId, payloadHash, JSON.stringify(data), now)
  ])

  return readEditorialBriefing(database, claims, briefingId, now)
}

export async function publishOrScheduleEditorialBriefing(
  database: D1Database,
  claims: VerifiedSessionClaims,
  briefingId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<EditorialBriefing> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeAdmin(database, claims, now)

  const parsed = publishOrScheduleEditorialBriefingInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new EditorialBriefingError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const current = await database
    .prepare('SELECT version FROM editorial_seo_briefings WHERE id = ?')
    .bind(briefingId)
    .first<{ version: number }>()

  if (!current) {
    throw new EditorialBriefingError('not_found', 'Briefing not found')
  }

  if (current.version !== data.expectedVersion) {
    throw new EditorialBriefingError(
      'version_conflict',
      `Expected version ${data.expectedVersion} but found ${current.version}`
    )
  }

  const resultVersion = current.version + 1
  const newStatus = data.action === 'publish' ? 'published' : data.action === 'schedule' ? 'scheduled' : 'archived'
  const actualPub = data.action === 'publish' ? (data.actualPublishedAt ?? now) : null

  await database.batch([
    database
      .prepare(
        `UPDATE editorial_seo_briefings SET
          status = ?1, actual_published_at = ?2, version = ?3, updated_at = ?4
        WHERE id = ?5 AND version = ?6`
      )
      .bind(newStatus, actualPub, resultVersion, now, briefingId, data.expectedVersion),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_commands (
          command_id, briefing_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        commandId,
        briefingId,
        claims.identityId,
        data.action,
        data.expectedVersion,
        resultVersion,
        payloadHash,
        JSON.stringify(data),
        now
      ),
    database
      .prepare(
        `INSERT INTO editorial_seo_briefing_audit (
          command_id, actor_id, briefing_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(commandId, claims.identityId, briefingId, data.action, payloadHash, JSON.stringify(data), now)
  ])

  return readEditorialBriefing(database, claims, briefingId, now)
}

export async function readEditorialBriefing(
  database: D1Database,
  claims: VerifiedSessionClaims,
  briefingId: string,
  now?: string
): Promise<EditorialBriefing> {
  await authorizeAdmin(database, claims, now)

  const row = await database
    .prepare('SELECT * FROM editorial_seo_briefings WHERE id = ?')
    .bind(briefingId)
    .first<EditorialBriefingRow>()

  if (!row) {
    throw new EditorialBriefingError('not_found', 'Briefing not found')
  }

  return parseRow(row)
}

export async function listEditorialBriefings(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { searchIntent?: string; reviewStatus?: string; month?: string } = {},
  now?: string
): Promise<EditorialBriefing[]> {
  await authorizeAdmin(database, claims, now)

  let sql = 'SELECT * FROM editorial_seo_briefings WHERE 1=1'
  const binds: string[] = []

  if (query.searchIntent) {
    sql += ' AND search_intent = ?'
    binds.push(query.searchIntent)
  }
  if (query.reviewStatus) {
    sql += ' AND review_status = ?'
    binds.push(query.reviewStatus)
  }
  if (query.month) {
    sql += ' AND target_publish_date LIKE ?'
    binds.push(`${query.month}%`)
  }

  sql += ' ORDER BY target_publish_date ASC, created_at DESC'

  const stmt = binds.length ? database.prepare(sql).bind(...binds) : database.prepare(sql)
  const result = await stmt.all<EditorialBriefingRow>()
  return (result.results || []).map(parseRow)
}

export async function readUnifiedEditorialCalendar(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { month: string },
  options: { now?: string } = {}
): Promise<UnifiedEditorialCalendar> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeAdmin(database, claims, now)

  const briefings = await listEditorialBriefings(database, claims, { month: query.month }, now)

  const totalPlanned = briefings.filter((b) => b.status === 'planned').length
  const totalInReview = briefings.filter((b) => b.reviewStatus === 'in_review').length
  const totalApproved = briefings.filter((b) => b.reviewStatus === 'approved').length
  const totalPublished = briefings.filter((b) => b.status === 'published').length

  return {
    month: query.month,
    timeZone: 'Europe/Madrid',
    briefings,
    metrics: {
      totalPlanned,
      totalInReview,
      totalApproved,
      totalPublished
    }
  }
}
