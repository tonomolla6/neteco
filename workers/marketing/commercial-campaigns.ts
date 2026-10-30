import {
  detectCommercialCampaignConflicts,
  type CampaignAssetType,
  type CampaignConflict,
  type CommercialCalendarFeed,
  type CommercialCalendarDay,
  type CommercialCampaign,
  type CampaignLinkedAsset
} from '../../shared/commercial-campaigns'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from '../catalog/inventory'

export class CommercialCampaignError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'CommercialCampaignError'
  }
}

interface CampaignRow {
  id: string
  code: string
  name: string
  description: string
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled'
  channel_type: 'omnichannel' | 'web' | 'email' | 'mobile'
  target_audience: 'all' | 'b2b' | 'b2c' | 'vip' | 'new_customers'
  priority: number
  budget_limit_cents: number | null
  start_at: string
  end_at: string
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

interface AssetRow {
  id: string
  campaign_id: string
  asset_type: CampaignAssetType
  asset_id: string
  asset_name: string
  placement_or_slot: string | null
  start_at: string
  end_at: string
  status: 'linked' | 'active' | 'inactive' | 'paused'
  config_json: string
  created_at: string
  updated_at: string
}

async function verifyCampaignPermission(db: D1Database, actorId: string, now: string): Promise<void> {
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
    throw new CommercialCampaignError('forbidden')
  }
}

export async function createCommercialCampaign(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    code: string
    name: string
    description?: string
    channelType: 'omnichannel' | 'web' | 'email' | 'mobile'
    targetAudience?: 'all' | 'b2b' | 'b2c' | 'vip' | 'new_customers'
    priority?: number
    budgetLimitCents?: number
    startAt: string
    endAt: string
    now?: string
  }
): Promise<CommercialCampaign> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  if (input.endAt < input.startAt) {
    throw new CommercialCampaignError('invalid_dates')
  }

  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Idempotency check
  const existingCmd = await db
    .prepare('SELECT campaign_id, payload_hash FROM commercial_campaign_commands WHERE command_id = ?1')
    .bind(input.commandId)
    .first<{ campaign_id: string; payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) {
      throw new CommercialCampaignError('command_id_conflict')
    }
    return (await getCommercialCampaignDetail(db, existingCmd.campaign_id)) as CommercialCampaign
  }

  const campaignId = crypto.randomUUID()
  const targetAudience = input.targetAudience ?? 'all'
  const priority = input.priority ?? 50
  const description = input.description && input.description.trim().length >= 3 ? input.description.trim() : input.name

  await db
    .prepare(
      `
      INSERT INTO commercial_campaigns (
        id, code, name, description, status, channel_type, target_audience, priority, budget_limit_cents, start_at, end_at, version, created_at, updated_at, created_by
      ) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11, ?12)
    `
    )
    .bind(
      campaignId,
      input.code,
      input.name,
      description,
      input.channelType,
      targetAudience,
      priority,
      input.budgetLimitCents ?? null,
      input.startAt,
      input.endAt,
      now,
      input.actorId
    )
    .run()

  await db
    .prepare(
      `
      INSERT INTO commercial_campaign_commands (id, command_id, actor_id, action, campaign_id, payload_hash, payload_json, created_at)
      VALUES (?1, ?2, ?3, 'create_campaign', ?4, ?5, ?6, ?7)
    `
    )
    .bind(crypto.randomUUID(), input.commandId, input.actorId, campaignId, payloadHash, JSON.stringify(input), now)
    .run()

  return {
    id: campaignId,
    code: input.code,
    name: input.name,
    description,
    status: 'draft',
    channelType: input.channelType,
    targetAudience,
    priority,
    budgetLimitCents: input.budgetLimitCents ?? null,
    startAt: input.startAt,
    endAt: input.endAt,
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

export async function updateCommercialCampaign(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    campaignId: string
    expectedVersion: number
    name?: string
    description?: string
    status?: 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled'
    priority?: number
    startAt?: string
    endAt?: string
    now?: string
  }
): Promise<CommercialCampaign> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const current = await db
    .prepare('SELECT * FROM commercial_campaigns WHERE id = ?1')
    .bind(input.campaignId)
    .first<CampaignRow>()

  if (!current) throw new CommercialCampaignError('campaign_not_found')
  if (current.version !== input.expectedVersion) throw new CommercialCampaignError('campaign_version_conflict')

  const nextVersion = current.version + 1
  const name = input.name ?? current.name
  const description = input.description ?? current.description
  const status = input.status ?? current.status
  const priority = input.priority ?? current.priority
  const startAt = input.startAt ?? current.start_at
  const endAt = input.endAt ?? current.end_at

  if (endAt < startAt) throw new CommercialCampaignError('invalid_dates')

  await db
    .prepare(
      `
      UPDATE commercial_campaigns
      SET name = ?1, description = ?2, status = ?3, priority = ?4, start_at = ?5, end_at = ?6, version = ?7, updated_at = ?8
      WHERE id = ?9
    `
    )
    .bind(name, description, status, priority, startAt, endAt, nextVersion, now, input.campaignId)
    .run()

  return {
    id: current.id,
    code: current.code,
    name,
    description,
    status,
    channelType: current.channel_type,
    targetAudience: current.target_audience,
    priority,
    budgetLimitCents: current.budget_limit_cents,
    startAt,
    endAt,
    version: nextVersion,
    createdAt: current.created_at,
    updatedAt: now
  }
}

export async function linkCampaignAsset(
  db: D1Database,
  input: {
    commandId: string
    actorId: string
    campaignId: string
    assetType: CampaignAssetType
    assetId: string
    assetName: string
    placementOrSlot?: string
    startAt: string
    endAt: string
    config?: Record<string, unknown>
    now?: string
  }
): Promise<CampaignLinkedAsset> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  const assetUuid = crypto.randomUUID()
  const config = input.config ?? {}

  await db
    .prepare(
      `
      INSERT INTO campaign_linked_assets (
        id, campaign_id, asset_type, asset_id, asset_name, placement_or_slot, start_at, end_at, status, config_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'linked', ?9, ?10, ?10)
    `
    )
    .bind(
      assetUuid,
      input.campaignId,
      input.assetType,
      input.assetId,
      input.assetName,
      input.placementOrSlot ?? null,
      input.startAt,
      input.endAt,
      JSON.stringify(config),
      now
    )
    .run()

  return {
    id: assetUuid,
    campaignId: input.campaignId,
    assetType: input.assetType,
    assetId: input.assetId,
    assetName: input.assetName,
    placementOrSlot: input.placementOrSlot,
    startAt: input.startAt,
    endAt: input.endAt,
    status: 'linked',
    config,
    createdAt: now,
    updatedAt: now
  }
}

export async function unlinkCampaignAsset(
  db: D1Database,
  input: { commandId: string; actorId: string; campaignId: string; assetId: string; now?: string }
): Promise<{ unlinked: true }> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCampaignPermission(db, input.actorId, now)

  await db
    .prepare('DELETE FROM campaign_linked_assets WHERE id = ?1 AND campaign_id = ?2')
    .bind(input.assetId, input.campaignId)
    .run()

  return { unlinked: true }
}

export async function getCommercialCampaignDetail(
  db: D1Database,
  campaignId: string,
  options?: { actorId?: string; now?: string }
): Promise<CommercialCampaign & { linkedAssets: CampaignLinkedAsset[]; conflicts: CampaignConflict[] }> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (options?.actorId) {
    await verifyCampaignPermission(db, options.actorId, now)
  }

  const row = await db.prepare('SELECT * FROM commercial_campaigns WHERE id = ?1').bind(campaignId).first<CampaignRow>()

  if (!row) throw new CommercialCampaignError('campaign_not_found')

  const { results: assetRows } = await db
    .prepare('SELECT * FROM campaign_linked_assets WHERE campaign_id = ?1 ORDER BY created_at ASC')
    .bind(campaignId)
    .all<AssetRow>()

  const linkedAssets: CampaignLinkedAsset[] = (assetRows ?? []).map((a) => ({
    id: a.id,
    campaignId: a.campaign_id,
    assetType: a.asset_type,
    assetId: a.asset_id,
    assetName: a.asset_name,
    placementOrSlot: a.placement_or_slot,
    startAt: a.start_at,
    endAt: a.end_at,
    status: a.status,
    config: JSON.parse(a.config_json || '{}') as Record<string, unknown>,
    createdAt: a.created_at,
    updatedAt: a.updated_at
  }))

  const conflicts = await detectCampaignConflictsInPeriod(db, {
    startAt: row.start_at,
    endAt: row.end_at
  })

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    channelType: row.channel_type,
    targetAudience: row.target_audience,
    priority: row.priority,
    budgetLimitCents: row.budget_limit_cents,
    startAt: row.start_at,
    endAt: row.end_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedAssets,
    conflicts: conflicts.filter((c) => c.campaignA.id === row.id || c.campaignB.id === row.id)
  }
}

export async function listCommercialCampaigns(
  db: D1Database,
  query: { status?: string; targetAudience?: string; actorId?: string; now?: string } = {}
): Promise<CommercialCampaign[]> {
  const now = query.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (query.actorId) {
    await verifyCampaignPermission(db, query.actorId, now)
  }

  let sql = 'SELECT * FROM commercial_campaigns WHERE 1=1'
  const params: (string | number)[] = []

  if (query.status) {
    params.push(query.status)
    sql += ` AND status = ?${params.length}`
  }
  if (query.targetAudience) {
    params.push(query.targetAudience)
    sql += ` AND target_audience = ?${params.length}`
  }
  sql += ' ORDER BY start_at DESC, priority DESC'

  const stmt = db.prepare(sql)
  const bound = params.length > 0 ? stmt.bind(...params) : stmt
  const { results } = await bound.all<CampaignRow>()

  return (results ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    status: r.status,
    channelType: r.channel_type,
    targetAudience: r.target_audience,
    priority: r.priority,
    budgetLimitCents: r.budget_limit_cents,
    startAt: r.start_at,
    endAt: r.end_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function detectCampaignConflictsInPeriod(
  db: D1Database,
  period: { startAt: string; endAt: string; actorId?: string; now?: string }
): Promise<CampaignConflict[]> {
  const now = period.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (period.actorId) {
    await verifyCampaignPermission(db, period.actorId, now)
  }

  const { results: campaignRows } = await db
    .prepare(
      'SELECT id, code, name, target_audience, start_at, end_at FROM commercial_campaigns WHERE start_at <= ?1 AND end_at >= ?2'
    )
    .bind(period.endAt, period.startAt)
    .all<{ id: string; code: string; name: string; target_audience: string; start_at: string; end_at: string }>()

  const campaigns = (campaignRows ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    targetAudience: r.target_audience,
    startAt: r.start_at,
    endAt: r.end_at
  }))

  const { results: assetRows } = await db
    .prepare(
      'SELECT id, campaign_id, asset_type, asset_id, asset_name, placement_or_slot, start_at, end_at FROM campaign_linked_assets WHERE start_at <= ?1 AND end_at >= ?2'
    )
    .bind(period.endAt, period.startAt)
    .all<{
      id: string
      campaign_id: string
      asset_type: string
      asset_id: string
      asset_name: string
      placement_or_slot: string | null
      start_at: string
      end_at: string
    }>()

  const assets = (assetRows ?? []).map((a) => ({
    id: a.id,
    campaignId: a.campaign_id,
    assetType: a.asset_type as CampaignAssetType,
    assetId: a.asset_id,
    assetName: a.asset_name,
    placementOrSlot: a.placement_or_slot,
    startAt: a.start_at,
    endAt: a.end_at
  }))

  return detectCommercialCampaignConflicts(campaigns, assets)
}

export async function getCommercialCalendarFeed(
  db: D1Database,
  options: { month: string; actorId?: string; now?: string }
): Promise<CommercialCalendarFeed> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (options.actorId) {
    await verifyCampaignPermission(db, options.actorId, now)
  }

  const [yearStr, monthStr] = options.month.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const monthStart = `${options.month}-01T00:00:00Z`

  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
  const monthEnd = `${nextMonth}-01T00:00:00Z`

  const campaigns = await listCommercialCampaigns(db)
  const activeConflicts = await detectCampaignConflictsInPeriod(db, { startAt: monthStart, endAt: monthEnd })

  const { results: assetRows } = await db
    .prepare(
      'SELECT id, campaign_id, asset_type, asset_name, placement_or_slot, start_at, end_at FROM campaign_linked_assets WHERE start_at < ?1 AND end_at >= ?2'
    )
    .bind(monthEnd, monthStart)
    .all<{
      id: string
      campaign_id: string
      asset_type: string
      asset_name: string
      placement_or_slot: string | null
      start_at: string
      end_at: string
    }>()

  const daysInMonth = new Date(year, month, 0).getDate()
  const days: CommercialCalendarDay[] = []

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = `${options.month}-${String(day).padStart(2, '0')}`
    const dayStart = `${dayStr}T00:00:00Z`
    const dayEnd = `${dayStr}T23:59:59Z`

    const dayCampaigns = campaigns.filter((c) => c.startAt <= dayEnd && c.endAt >= dayStart)
    const dayAssets = (assetRows ?? [])
      .filter((a) => a.start_at <= dayEnd && a.end_at >= dayStart)
      .map((a) => ({
        id: a.id,
        campaignId: a.campaign_id,
        assetType: a.asset_type as CampaignAssetType,
        assetName: a.asset_name,
        placement: a.placement_or_slot ?? undefined
      }))

    const dayConflicts = activeConflicts.filter(
      (conf) =>
        (conf.campaignA.startAt <= dayEnd && conf.campaignA.endAt >= dayStart) ||
        (conf.campaignB.startAt <= dayEnd && conf.campaignB.endAt >= dayStart)
    )

    days.push({
      date: dayStr,
      campaignsCount: dayCampaigns.length,
      campaigns: dayCampaigns.map((c) => ({ id: c.id, name: c.name, priority: c.priority, status: c.status })),
      assets: dayAssets,
      conflicts: dayConflicts
    })
  }

  return {
    month: options.month,
    campaigns: campaigns.filter((c) => c.startAt < monthEnd && c.endAt >= monthStart),
    days,
    activeConflicts
  }
}
