import {
  verifySeasonalCampaignCoordination,
  type CoordinationCheckResult,
  type NeedPillar,
  type WindowPillar,
  type InventoryPillar,
  type LogisticsPillar,
  type ContentPillar,
  type MarginPillar,
  type PostmortemActionItem,
  type SeasonalCampaignPostmortem,
  type SeasonalCampaignStatus,
  type SeasonalSectorCampaign,
  type SectorType,
  type SeasonType
} from '../../shared/seasonal-campaigns'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from '../catalog/inventory'

export class SeasonalCampaignError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'SeasonalCampaignError'
  }
}

interface CampaignRow {
  id: string
  code: string
  name: string
  sector: SectorType
  season: SeasonType
  year: number
  status: SeasonalCampaignStatus
  need_justification: string
  target_customer_profile: NeedPillar['targetCustomerProfile']
  procurement_start_at: string
  window_start_at: string
  window_end_at: string
  inventory_plan_json: string
  logistics_plan_json: string
  content_plan_json: string
  target_revenue_cents: number
  budget_limit_cents: number
  min_margin_basis_points: number
  max_discount_basis_points: number
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

interface PostmortemRow {
  id: string
  campaign_id: string
  status: 'draft' | 'approved' | 'archived'
  actual_revenue_cents: number
  actual_margin_basis_points: number
  target_margin_achieved: number
  stockout_occurred: number
  stockout_details: string | null
  logistics_incidents_count: number
  logistics_incident_notes: string | null
  content_performance_score: number | null
  roi_basis_points: number | null
  key_learnings: string
  action_items_json: string
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

function parseCampaignRow(row: CampaignRow): SeasonalSectorCampaign {
  let inventory: InventoryPillar
  try {
    inventory = JSON.parse(row.inventory_plan_json)
  } catch {
    inventory = { items: [], bufferPercentage: 15 }
  }

  let logistics: LogisticsPillar
  try {
    logistics = JSON.parse(row.logistics_plan_json)
  } catch {
    logistics = { allowedProfiles: ['parcel'], maxLeadTimeDays: 5, localDeliveryPriority: false }
  }

  let content: ContentPillar
  try {
    content = JSON.parse(row.content_plan_json)
  } catch {
    content = { bannerSlots: [], marketingTags: [] }
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sector: row.sector,
    season: row.season,
    year: row.year,
    status: row.status,
    need: {
      needJustification: row.need_justification,
      targetCustomerProfile: row.target_customer_profile
    },
    window: {
      procurementStartAt: row.procurement_start_at,
      windowStartAt: row.window_start_at,
      windowEndAt: row.window_end_at
    },
    inventory,
    logistics,
    content,
    margin: {
      targetRevenueCents: row.target_revenue_cents,
      budgetLimitCents: row.budget_limit_cents,
      minMarginBasisPoints: row.min_margin_basis_points,
      maxDiscountBasisPoints: row.max_discount_basis_points
    },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

function parsePostmortemRow(row: PostmortemRow): SeasonalCampaignPostmortem {
  let actionItems: PostmortemActionItem[]
  try {
    actionItems = JSON.parse(row.action_items_json)
  } catch {
    actionItems = []
  }

  return {
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status,
    actualRevenueCents: row.actual_revenue_cents,
    actualMarginBasisPoints: row.actual_margin_basis_points,
    targetMarginAchieved: row.target_margin_achieved === 1,
    stockoutOccurred: row.stockout_occurred === 1,
    stockoutDetails: row.stockout_details,
    logisticsIncidentsCount: row.logistics_incidents_count,
    logisticsIncidentNotes: row.logistics_incident_notes,
    contentPerformanceScore: row.content_performance_score,
    roiBasisPoints: row.roi_basis_points,
    keyLearnings: row.key_learnings,
    actionItems,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

export async function verifyCampaignPermission(db: D1Database, actorId: string, now: string): Promise<void> {
  const session = await db
    .prepare(
      'SELECT id, session_version FROM auth_sessions WHERE identity_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .bind(actorId)
    .first<{ id: string; session_version: number }>()

  const claims: VerifiedSessionClaims = {
    sessionId: session?.id ?? '20000000-0000-4000-8000-000000000001',
    identityId: actorId,
    sessionVersion: session?.session_version ?? 1
  }

  const primary = await authorizeD1Session(db, claims, 'campaigns.manage', { now, requireMfa: false })
  if (primary.allowed) return

  const fallback = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: false })
  if (!fallback.allowed) {
    throw new SeasonalCampaignError('forbidden')
  }
}

export async function createSeasonalSectorCampaign(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    code: string
    name: string
    sector: SectorType
    season: SeasonType
    year: number
    need: NeedPillar
    window: WindowPillar
    inventory: InventoryPillar
    logistics: LogisticsPillar
    content: ContentPillar
    margin: MarginPillar
    now?: string
  }
): Promise<SeasonalSectorCampaign> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  if (
    input.window.windowStartAt < input.window.procurementStartAt ||
    input.window.windowEndAt < input.window.windowStartAt
  ) {
    throw new SeasonalCampaignError('invalid_dates')
  }

  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Idempotency replay check
  const prior = await db
    .prepare('SELECT campaign_id FROM seasonal_campaign_commands WHERE command_id = ?1 AND payload_hash = ?2')
    .bind(input.commandId, payloadHash)
    .first<{ campaign_id: string }>()

  if (prior) {
    const existing = await getSeasonalSectorCampaignDetail(db, prior.campaign_id)
    if (existing) return existing
  }

  const id = crypto.randomUUID()

  await db.batch([
    db
      .prepare(
        `INSERT INTO seasonal_sector_campaigns (
          id, code, name, sector, season, year, status,
          need_justification, target_customer_profile,
          procurement_start_at, window_start_at, window_end_at,
          inventory_plan_json, logistics_plan_json, content_plan_json,
          target_revenue_cents, budget_limit_cents, min_margin_basis_points, max_discount_basis_points,
          version, created_at, updated_at, created_by
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, 'draft',
          ?7, ?8,
          ?9, ?10, ?11,
          ?12, ?13, ?14,
          ?15, ?16, ?17, ?18,
          1, ?19, ?19, ?20
        )`
      )
      .bind(
        id,
        input.code,
        input.name,
        input.sector,
        input.season,
        input.year,
        input.need.needJustification,
        input.need.targetCustomerProfile,
        input.window.procurementStartAt,
        input.window.windowStartAt,
        input.window.windowEndAt,
        JSON.stringify(input.inventory),
        JSON.stringify(input.logistics),
        JSON.stringify(input.content),
        input.margin.targetRevenueCents,
        input.margin.budgetLimitCents,
        input.margin.minMarginBasisPoints,
        input.margin.maxDiscountBasisPoints,
        now,
        input.actorId
      ),
    db
      .prepare(
        `INSERT INTO seasonal_campaign_commands (
          id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
        ) VALUES (?1, ?2, ?3, 'create_campaign', ?4, ?5, ?6, ?7)`
      )
      .bind(crypto.randomUUID(), input.commandId, input.actorId, id, payloadHash, JSON.stringify(input), now)
  ])

  const created = await getSeasonalSectorCampaignDetail(db, id)
  if (!created) throw new SeasonalCampaignError('not_found')
  return created
}

export async function updateSeasonalSectorCampaign(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    campaignId: string
    expectedVersion: number
    name?: string
    need?: NeedPillar
    window?: WindowPillar
    inventory?: InventoryPillar
    logistics?: LogisticsPillar
    content?: ContentPillar
    margin?: MarginPillar
    now?: string
  }
): Promise<SeasonalSectorCampaign> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const current = await db
    .prepare('SELECT * FROM seasonal_sector_campaigns WHERE id = ?1')
    .bind(input.campaignId)
    .first<CampaignRow>()

  if (!current) throw new SeasonalCampaignError('not_found')
  if (current.version !== input.expectedVersion) throw new SeasonalCampaignError('version_conflict')

  const parsedCurrent = parseCampaignRow(current)
  const window = input.window ?? parsedCurrent.window

  if (window.windowStartAt < window.procurementStartAt || window.windowEndAt < window.windowStartAt) {
    throw new SeasonalCampaignError('invalid_dates')
  }

  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Idempotency replay check
  const prior = await db
    .prepare('SELECT campaign_id FROM seasonal_campaign_commands WHERE command_id = ?1 AND payload_hash = ?2')
    .bind(input.commandId, payloadHash)
    .first<{ campaign_id: string }>()

  if (prior) {
    const existing = await getSeasonalSectorCampaignDetail(db, prior.campaign_id)
    if (existing) return existing
  }

  const nextVersion = current.version + 1
  const name = input.name ?? current.name
  const need = input.need ?? parsedCurrent.need
  const inventory = input.inventory ?? parsedCurrent.inventory
  const logistics = input.logistics ?? parsedCurrent.logistics
  const content = input.content ?? parsedCurrent.content
  const margin = input.margin ?? parsedCurrent.margin

  await db.batch([
    db
      .prepare(
        `UPDATE seasonal_sector_campaigns SET
          name = ?1,
          need_justification = ?2,
          target_customer_profile = ?3,
          procurement_start_at = ?4,
          window_start_at = ?5,
          window_end_at = ?6,
          inventory_plan_json = ?7,
          logistics_plan_json = ?8,
          content_plan_json = ?9,
          target_revenue_cents = ?10,
          budget_limit_cents = ?11,
          min_margin_basis_points = ?12,
          max_discount_basis_points = ?13,
          version = ?14,
          updated_at = ?15
        WHERE id = ?16 AND version = ?17`
      )
      .bind(
        name,
        need.needJustification,
        need.targetCustomerProfile,
        window.procurementStartAt,
        window.windowStartAt,
        window.windowEndAt,
        JSON.stringify(inventory),
        JSON.stringify(logistics),
        JSON.stringify(content),
        margin.targetRevenueCents,
        margin.budgetLimitCents,
        margin.minMarginBasisPoints,
        margin.maxDiscountBasisPoints,
        nextVersion,
        now,
        input.campaignId,
        input.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO seasonal_campaign_commands (
          id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
        ) VALUES (?1, ?2, ?3, 'update_campaign', ?4, ?5, ?6, ?7)`
      )
      .bind(
        crypto.randomUUID(),
        input.commandId,
        input.actorId,
        input.campaignId,
        payloadHash,
        JSON.stringify(input),
        now
      )
  ])

  const updated = await getSeasonalSectorCampaignDetail(db, input.campaignId)
  if (!updated) throw new SeasonalCampaignError('not_found')
  return updated
}

export async function setSeasonalCampaignStatus(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    campaignId: string
    expectedVersion: number
    status: SeasonalCampaignStatus
    now?: string
  }
): Promise<SeasonalSectorCampaign> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const current = await db
    .prepare('SELECT * FROM seasonal_sector_campaigns WHERE id = ?1')
    .bind(input.campaignId)
    .first<CampaignRow>()

  if (!current) throw new SeasonalCampaignError('not_found')
  if (current.version !== input.expectedVersion) throw new SeasonalCampaignError('version_conflict')

  const parsedCurrent = parseCampaignRow(current)

  // Critical coordination gate: activating requires all 6 pillars to be coordinated and coherent
  if (input.status === 'active') {
    const coordination = verifySeasonalCampaignCoordination(parsedCurrent)
    if (!coordination.isFullyCoordinated) {
      throw new SeasonalCampaignError(
        `uncoordinated_campaign: ${coordination.missingPillars.join(', ')} missing; ${coordination.inconsistencies.join(', ')}`
      )
    }
  }

  const payloadHash = await sha256Hex(JSON.stringify(input))
  const nextVersion = current.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE seasonal_sector_campaigns SET
          status = ?1,
          version = ?2,
          updated_at = ?3
        WHERE id = ?4 AND version = ?5`
      )
      .bind(input.status, nextVersion, now, input.campaignId, input.expectedVersion),
    db
      .prepare(
        `INSERT INTO seasonal_campaign_commands (
          id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
        ) VALUES (?1, ?2, ?3, 'change_status', ?4, ?5, ?6, ?7)`
      )
      .bind(
        crypto.randomUUID(),
        input.commandId,
        input.actorId,
        input.campaignId,
        payloadHash,
        JSON.stringify(input),
        now
      )
  ])

  const updated = await getSeasonalSectorCampaignDetail(db, input.campaignId)
  if (!updated) throw new SeasonalCampaignError('not_found')
  return updated
}

export async function saveSeasonalCampaignPostmortem(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    campaignId: string
    expectedVersion: number
    actualRevenueCents: number
    actualMarginBasisPoints: number
    targetMarginAchieved: boolean
    stockoutOccurred: boolean
    stockoutDetails?: string | null
    logisticsIncidentsCount: number
    logisticsIncidentNotes?: string | null
    contentPerformanceScore?: number | null
    roiBasisPoints?: number | null
    keyLearnings: string
    actionItems: PostmortemActionItem[]
    now?: string
  }
): Promise<SeasonalCampaignPostmortem> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const campaign = await db
    .prepare('SELECT id, status FROM seasonal_sector_campaigns WHERE id = ?1')
    .bind(input.campaignId)
    .first<{ id: string; status: string }>()

  if (!campaign) throw new SeasonalCampaignError('not_found')

  const existingPostmortem = await db
    .prepare('SELECT * FROM seasonal_campaign_postmortems WHERE campaign_id = ?1')
    .bind(input.campaignId)
    .first<PostmortemRow>()

  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Idempotency replay check
  const prior = await db
    .prepare('SELECT campaign_id FROM seasonal_campaign_commands WHERE command_id = ?1 AND payload_hash = ?2')
    .bind(input.commandId, payloadHash)
    .first<{ campaign_id: string }>()

  if (prior && existingPostmortem) {
    return parsePostmortemRow(existingPostmortem)
  }

  const postmortemId = existingPostmortem?.id ?? crypto.randomUUID()
  const nextVersion = existingPostmortem ? existingPostmortem.version + 1 : 1

  if (existingPostmortem && existingPostmortem.version !== input.expectedVersion) {
    throw new SeasonalCampaignError('version_conflict')
  }

  if (existingPostmortem) {
    await db.batch([
      db
        .prepare(
          `UPDATE seasonal_campaign_postmortems SET
            actual_revenue_cents = ?1,
            actual_margin_basis_points = ?2,
            target_margin_achieved = ?3,
            stockout_occurred = ?4,
            stockout_details = ?5,
            logistics_incidents_count = ?6,
            logistics_incident_notes = ?7,
            content_performance_score = ?8,
            roi_basis_points = ?9,
            key_learnings = ?10,
            action_items_json = ?11,
            version = ?12,
            updated_at = ?13
          WHERE id = ?14 AND version = ?15`
        )
        .bind(
          input.actualRevenueCents,
          input.actualMarginBasisPoints,
          input.targetMarginAchieved ? 1 : 0,
          input.stockoutOccurred ? 1 : 0,
          input.stockoutDetails ?? null,
          input.logisticsIncidentsCount,
          input.logisticsIncidentNotes ?? null,
          input.contentPerformanceScore ?? null,
          input.roiBasisPoints ?? null,
          input.keyLearnings,
          JSON.stringify(input.actionItems),
          nextVersion,
          now,
          existingPostmortem.id,
          input.expectedVersion
        ),
      db
        .prepare(
          `INSERT INTO seasonal_campaign_commands (
            id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
          ) VALUES (?1, ?2, ?3, 'save_postmortem', ?4, ?5, ?6, ?7)`
        )
        .bind(
          crypto.randomUUID(),
          input.commandId,
          input.actorId,
          input.campaignId,
          payloadHash,
          JSON.stringify(input),
          now
        )
    ])
  } else {
    await db.batch([
      db
        .prepare(
          `INSERT INTO seasonal_campaign_postmortems (
            id, campaign_id, status,
            actual_revenue_cents, actual_margin_basis_points, target_margin_achieved,
            stockout_occurred, stockout_details, logistics_incidents_count, logistics_incident_notes,
            content_performance_score, roi_basis_points, key_learnings, action_items_json,
            version, created_at, updated_at, created_by
          ) VALUES (
            ?1, ?2, 'draft',
            ?3, ?4, ?5,
            ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13,
            1, ?14, ?14, ?15
          )`
        )
        .bind(
          postmortemId,
          input.campaignId,
          input.actualRevenueCents,
          input.actualMarginBasisPoints,
          input.targetMarginAchieved ? 1 : 0,
          input.stockoutOccurred ? 1 : 0,
          input.stockoutDetails ?? null,
          input.logisticsIncidentsCount,
          input.logisticsIncidentNotes ?? null,
          input.contentPerformanceScore ?? null,
          input.roiBasisPoints ?? null,
          input.keyLearnings,
          JSON.stringify(input.actionItems),
          now,
          input.actorId
        ),
      db
        .prepare(
          `INSERT INTO seasonal_campaign_commands (
            id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
          ) VALUES (?1, ?2, ?3, 'save_postmortem', ?4, ?5, ?6, ?7)`
        )
        .bind(
          crypto.randomUUID(),
          input.commandId,
          input.actorId,
          input.campaignId,
          payloadHash,
          JSON.stringify(input),
          now
        )
    ])
  }

  const saved = await db
    .prepare('SELECT * FROM seasonal_campaign_postmortems WHERE id = ?1')
    .bind(postmortemId)
    .first<PostmortemRow>()

  if (!saved) throw new SeasonalCampaignError('not_found')
  return parsePostmortemRow(saved)
}

export async function approveSeasonalCampaignPostmortem(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    postmortemId: string
    expectedVersion: number
    now?: string
  }
): Promise<SeasonalCampaignPostmortem> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const current = await db
    .prepare('SELECT * FROM seasonal_campaign_postmortems WHERE id = ?1')
    .bind(input.postmortemId)
    .first<PostmortemRow>()

  if (!current) throw new SeasonalCampaignError('not_found')
  if (current.version !== input.expectedVersion) throw new SeasonalCampaignError('version_conflict')

  const payloadHash = await sha256Hex(JSON.stringify(input))
  const nextVersion = current.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE seasonal_campaign_postmortems SET
          status = 'approved',
          version = ?1,
          updated_at = ?2
        WHERE id = ?3 AND version = ?4`
      )
      .bind(nextVersion, now, input.postmortemId, input.expectedVersion),
    db
      .prepare(
        `INSERT INTO seasonal_campaign_commands (
          id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at
        ) VALUES (?1, ?2, ?3, 'approve_postmortem', ?4, ?5, ?6, ?7)`
      )
      .bind(
        crypto.randomUUID(),
        input.commandId,
        input.actorId,
        current.campaign_id,
        payloadHash,
        JSON.stringify(input),
        now
      )
  ])

  const approved = await db
    .prepare('SELECT * FROM seasonal_campaign_postmortems WHERE id = ?1')
    .bind(input.postmortemId)
    .first<PostmortemRow>()

  if (!approved) throw new SeasonalCampaignError('not_found')
  return parsePostmortemRow(approved)
}

export async function getSeasonalSectorCampaignDetail(
  db: D1Database,
  campaignId: string
): Promise<
  (SeasonalSectorCampaign & { coordination: CoordinationCheckResult; postmortem?: SeasonalCampaignPostmortem }) | null
> {
  const row = await db
    .prepare('SELECT * FROM seasonal_sector_campaigns WHERE id = ?1')
    .bind(campaignId)
    .first<CampaignRow>()

  if (!row) return null

  const campaign = parseCampaignRow(row)
  const coordination = verifySeasonalCampaignCoordination(campaign)

  const postmortemRow = await db
    .prepare('SELECT * FROM seasonal_campaign_postmortems WHERE campaign_id = ?1')
    .bind(campaignId)
    .first<PostmortemRow>()

  return {
    ...campaign,
    coordination,
    ...(postmortemRow ? { postmortem: parsePostmortemRow(postmortemRow) } : {})
  }
}

export async function listSeasonalSectorCampaigns(
  db: D1Database,
  filters: {
    sector?: SectorType
    season?: SeasonType
    year?: number
    status?: SeasonalCampaignStatus
  } = {}
): Promise<SeasonalSectorCampaign[]> {
  let sql = 'SELECT * FROM seasonal_sector_campaigns WHERE 1=1'
  const params: unknown[] = []

  if (filters.sector) {
    params.push(filters.sector)
    sql += ` AND sector = ?${params.length}`
  }
  if (filters.season) {
    params.push(filters.season)
    sql += ` AND season = ?${params.length}`
  }
  if (filters.year) {
    params.push(filters.year)
    sql += ` AND year = ?${params.length}`
  }
  if (filters.status) {
    params.push(filters.status)
    sql += ` AND status = ?${params.length}`
  }

  sql += ' ORDER BY window_start_at DESC, name ASC'

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<CampaignRow>()
  return results.map(parseCampaignRow)
}

export async function getSeasonalCampaignCalendar(
  db: D1Database,
  options: {
    year?: number
    sector?: SectorType
    season?: SeasonType
  } = {}
): Promise<{
  year: number
  sectorsRepresented: SectorType[]
  campaigns: Array<
    SeasonalSectorCampaign & {
      coordination: CoordinationCheckResult
      hasPostmortem: boolean
    }
  >
}> {
  const year = options.year ?? new Date().getFullYear()
  const list = await listSeasonalSectorCampaigns(db, {
    year,
    sector: options.sector,
    season: options.season
  })

  const sectorsRepresented = Array.from(new Set(list.map((c) => c.sector)))

  const campaignsWithMeta = await Promise.all(
    list.map(async (c) => {
      const coordination = verifySeasonalCampaignCoordination(c)
      const postmortem = await db
        .prepare('SELECT id FROM seasonal_campaign_postmortems WHERE campaign_id = ?1')
        .bind(c.id)
        .first<{ id: string }>()

      return {
        ...c,
        coordination,
        hasPostmortem: !!postmortem
      }
    })
  )

  return {
    year,
    sectorsRepresented,
    campaigns: campaignsWithMeta
  }
}
