import {
  type RecordSeoCostInput,
  type SeoContentDashboardResponse,
  type SeoDashboardFilter,
  type SeoLandingItem,
  type SeoQueryItem,
  type SeoSummary,
  type SeoSyncStatus,
  type SyncSeoMetricsInput,
  SeoContentDashboardError,
  recordSeoCostInputSchema,
  seoDashboardFilterSchema,
  syncSeoMetricsInputSchema
} from '../../shared/seo-content-dashboard'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

function requireCommandId(commandId: string | undefined): string {
  const value = commandId?.trim() ?? ''
  if (value.length < 1 || value.length > 128) {
    throw new SeoContentDashboardError('invalid_input', 'A client idempotency key (1-128 characters) is required')
  }
  return value
}

async function assertAdmin(database: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const result = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (!result.allowed) {
    if (result.code === 'unauthenticated') {
      throw new SeoContentDashboardError('unauthenticated', 'Session is unauthenticated or expired')
    }
    throw new SeoContentDashboardError('forbidden', 'Requires administration.manage permission')
  }
}

export async function syncSeoContentMetrics(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: () => string } = {}
): Promise<{ recordsProcessed: number; idempotentReplay: boolean }> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = syncSeoMetricsInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new SeoContentDashboardError('invalid_input', parsed.error.message)
  }
  const data: SyncSeoMetricsInput = parsed.data
  const commandId = requireCommandId(options.commandId)
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const readCommand = () =>
    database
      .prepare(
        'SELECT records_processed, payload_hash FROM seo_content_sync_commands WHERE actor_id = ? AND command_id = ?'
      )
      .bind(claims.identityId, commandId)
      .first<{ records_processed: number; payload_hash: string }>()
  const replayOf = (row: { records_processed: number; payload_hash: string }) => {
    if (row.payload_hash !== payloadHash) {
      throw new SeoContentDashboardError('conflict', 'Idempotency key reused with a different payload')
    }
    return { recordsProcessed: row.records_processed, idempotentReplay: true }
  }

  const existingCmd = await readCommand()
  if (existingCmd) return replayOf(existingCmd)

  // Insert or update performance metrics
  const statements: D1PreparedStatement[] = []

  for (const item of data.metrics) {
    const id = crypto.randomUUID()
    statements.push(
      database
        .prepare(
          `INSERT INTO seo_content_performance_metrics (
            id, landing_path, query, device, sync_date, data_through_date, source,
            impressions, clicks, avg_position, assisted_orders_count,
            assisted_revenue_gross_cents, assisted_revenue_net_cents, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(landing_path, query, device, sync_date) DO UPDATE SET
            data_through_date = excluded.data_through_date,
            source = excluded.source,
            impressions = excluded.impressions,
            clicks = excluded.clicks,
            avg_position = excluded.avg_position,
            assisted_orders_count = excluded.assisted_orders_count,
            assisted_revenue_gross_cents = excluded.assisted_revenue_gross_cents,
            assisted_revenue_net_cents = excluded.assisted_revenue_net_cents`
        )
        .bind(
          id,
          item.landingPath,
          item.query,
          item.device,
          data.syncDate,
          data.dataThroughDate,
          data.source,
          item.impressions,
          item.clicks,
          item.avgPosition,
          item.assistedOrdersCount,
          item.assistedRevenueGrossCents,
          item.assistedRevenueNetCents,
          now
        )
    )
  }

  // Record command
  statements.push(
    database
      .prepare(
        `INSERT INTO seo_content_sync_commands (
          id, actor_id, command_id, session_id, session_version,
          payload_hash, sync_date, records_processed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        claims.identityId,
        commandId,
        claims.sessionId,
        claims.sessionVersion,
        payloadHash,
        data.syncDate,
        data.metrics.length,
        now
      )
  )

  try {
    await database.batch(statements)
  } catch (error) {
    // A concurrent identical command wins the UNIQUE(actor, command) race.
    const winner = await readCommand()
    if (winner) return replayOf(winner)
    throw error
  }

  return { recordsProcessed: data.metrics.length, idempotentReplay: false }
}

export async function recordSeoContentCost(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: () => string } = {}
): Promise<{ id: string; costCents: number; landingPath: string; idempotentReplay: boolean }> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = recordSeoCostInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new SeoContentDashboardError('invalid_input', parsed.error.message)
  }
  const data: RecordSeoCostInput = parsed.data
  const commandId = requireCommandId(options.commandId)
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const readCommand = () =>
    database
      .prepare(
        'SELECT landing_path, cost_cents, payload_hash FROM seo_content_cost_commands WHERE actor_id = ? AND command_id = ?'
      )
      .bind(claims.identityId, commandId)
      .first<{ landing_path: string; cost_cents: number; payload_hash: string }>()
  const replayOf = (row: { landing_path: string; cost_cents: number; payload_hash: string }) => {
    if (row.payload_hash !== payloadHash) {
      throw new SeoContentDashboardError('conflict', 'Idempotency key reused with a different payload')
    }
    return { id: commandId, costCents: row.cost_cents, landingPath: row.landing_path, idempotentReplay: true }
  }

  const existingCmd = await readCommand()
  if (existingCmd) return replayOf(existingCmd)

  const costId = crypto.randomUUID()
  const cmdId = crypto.randomUUID()

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO seo_content_costs (
          id, landing_path, period_start, period_end, cost_cents, cost_type, description, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          costId,
          data.landingPath,
          data.periodStart,
          data.periodEnd,
          data.costCents,
          data.costType,
          data.description,
          now
        ),
      database
        .prepare(
          `INSERT INTO seo_content_cost_commands (
          id, actor_id, command_id, session_id, session_version,
          payload_hash, landing_path, cost_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          cmdId,
          claims.identityId,
          commandId,
          claims.sessionId,
          claims.sessionVersion,
          payloadHash,
          data.landingPath,
          data.costCents,
          now
        )
    ])
  } catch (error) {
    const winner = await readCommand()
    if (winner) return replayOf(winner)
    throw error
  }

  return { id: costId, costCents: data.costCents, landingPath: data.landingPath, idempotentReplay: false }
}

export async function readSeoContentDashboard(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filter: unknown = {},
  options: { now?: () => string } = {}
): Promise<SeoContentDashboardResponse> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = seoDashboardFilterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new SeoContentDashboardError('invalid_input', parsed.error.message)
  }
  const f: SeoDashboardFilter = parsed.data

  const conditions: string[] = []
  const binds: (string | number)[] = []

  if (f.from) {
    conditions.push('sync_date >= ?')
    binds.push(f.from)
  }
  if (f.to) {
    conditions.push('sync_date <= ?')
    binds.push(f.to)
  }
  if (f.device) {
    conditions.push('device = ?')
    binds.push(f.device)
  }
  if (f.landingPath) {
    conditions.push('landing_path = ?')
    binds.push(f.landingPath)
  }
  if (f.query) {
    conditions.push('query = ?')
    binds.push(f.query)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 1. Overall Summary
  const summaryRow = await database
    .prepare(
      `SELECT
        COALESCE(SUM(impressions), 0) as total_impressions,
        COALESCE(SUM(clicks), 0) as total_clicks,
        COALESCE(SUM(avg_position * impressions), 0.0) as weighted_pos_sum,
        COALESCE(SUM(assisted_orders_count), 0) as assisted_orders_count,
        COALESCE(SUM(assisted_revenue_gross_cents), 0) as assisted_revenue_gross_cents,
        COALESCE(SUM(assisted_revenue_net_cents), 0) as assisted_revenue_net_cents
      FROM seo_content_performance_metrics
      ${whereClause}`
    )
    .bind(...binds)
    .first<{
      total_impressions: number
      total_clicks: number
      weighted_pos_sum: number
      assisted_orders_count: number
      assisted_revenue_gross_cents: number
      assisted_revenue_net_cents: number
    }>()

  // 2. Costs
  const costConditions: string[] = []
  const costBinds: (string | number)[] = []
  if (f.from) {
    costConditions.push('period_end >= ?')
    costBinds.push(f.from)
  }
  if (f.to) {
    costConditions.push('period_start <= ?')
    costBinds.push(f.to)
  }
  if (f.landingPath) {
    costConditions.push('landing_path = ?')
    costBinds.push(f.landingPath)
  }
  const costWhereClause = costConditions.length > 0 ? `WHERE ${costConditions.join(' AND ')}` : ''

  const costRow = await database
    .prepare(
      `SELECT COALESCE(SUM(cost_cents), 0) as total_cost_cents
       FROM seo_content_costs
       ${costWhereClause}`
    )
    .bind(...costBinds)
    .first<{ total_cost_cents: number }>()

  const totalImpressions = summaryRow?.total_impressions ?? 0
  const totalClicks = summaryRow?.total_clicks ?? 0
  const overallCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0
  const avgPosition = totalImpressions > 0 ? (summaryRow?.weighted_pos_sum ?? 0) / totalImpressions : 0
  const totalContentCostCents = costRow?.total_cost_cents ?? 0
  const assistedRevenueNetCents = summaryRow?.assisted_revenue_net_cents ?? 0
  const seoRoi = totalContentCostCents > 0 ? assistedRevenueNetCents / totalContentCostCents : 0

  const summary: SeoSummary = {
    totalImpressions,
    totalClicks,
    overallCtr,
    avgPosition,
    assistedOrdersCount: summaryRow?.assisted_orders_count ?? 0,
    assistedRevenueGrossCents: summaryRow?.assisted_revenue_gross_cents ?? 0,
    assistedRevenueNetCents,
    totalContentCostCents,
    seoRoi
  }

  // 3. Queries breakdown
  const queryRows = await database
    .prepare(
      `SELECT
        query,
        SUM(impressions) as impressions,
        SUM(clicks) as clicks,
        SUM(avg_position * impressions) as weighted_pos,
        SUM(assisted_orders_count) as assisted_orders_count,
        SUM(assisted_revenue_gross_cents) as assisted_revenue_gross_cents,
        SUM(assisted_revenue_net_cents) as assisted_revenue_net_cents
      FROM seo_content_performance_metrics
      ${whereClause}
      GROUP BY query
      ORDER BY clicks DESC, impressions DESC
      LIMIT 100`
    )
    .bind(...binds)
    .all<{
      query: string
      impressions: number
      clicks: number
      weighted_pos: number
      assisted_orders_count: number
      assisted_revenue_gross_cents: number
      assisted_revenue_net_cents: number
    }>()

  const queries: SeoQueryItem[] = (queryRows.results ?? []).map((r) => ({
    query: r.query,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    avgPosition: r.impressions > 0 ? r.weighted_pos / r.impressions : 0,
    assistedOrdersCount: r.assisted_orders_count,
    assistedRevenueGrossCents: r.assisted_revenue_gross_cents,
    assistedRevenueNetCents: r.assisted_revenue_net_cents
  }))

  // 4. Landing pages breakdown
  const landingRows = await database
    .prepare(
      `SELECT
        landing_path,
        SUM(impressions) as impressions,
        SUM(clicks) as clicks,
        SUM(avg_position * impressions) as weighted_pos,
        SUM(assisted_orders_count) as assisted_orders_count,
        SUM(assisted_revenue_gross_cents) as assisted_revenue_gross_cents,
        SUM(assisted_revenue_net_cents) as assisted_revenue_net_cents
      FROM seo_content_performance_metrics
      ${whereClause}
      GROUP BY landing_path
      ORDER BY clicks DESC, impressions DESC
      LIMIT 100`
    )
    .bind(...binds)
    .all<{
      landing_path: string
      impressions: number
      clicks: number
      weighted_pos: number
      assisted_orders_count: number
      assisted_revenue_gross_cents: number
      assisted_revenue_net_cents: number
    }>()

  // Costs per landing
  const costsPerLandingRows = await database
    .prepare(
      `SELECT landing_path, SUM(cost_cents) as cost_cents
       FROM seo_content_costs
       ${costWhereClause}
       GROUP BY landing_path`
    )
    .bind(...costBinds)
    .all<{ landing_path: string; cost_cents: number }>()

  const costMap = new Map<string, number>()
  for (const c of costsPerLandingRows.results ?? []) {
    costMap.set(c.landing_path, c.cost_cents)
  }

  const landingPages: SeoLandingItem[] = (landingRows.results ?? []).map((r) => {
    const costCents = costMap.get(r.landing_path) ?? 0
    const netRev = r.assisted_revenue_net_cents
    return {
      landingPath: r.landing_path,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
      avgPosition: r.impressions > 0 ? r.weighted_pos / r.impressions : 0,
      assistedOrdersCount: r.assisted_orders_count,
      assistedRevenueGrossCents: r.assisted_revenue_gross_cents,
      assistedRevenueNetCents: netRev,
      contentCostCents: costCents,
      seoRoi: costCents > 0 ? netRev / costCents : 0
    }
  })

  // 5. Sync Status
  const syncState = await getSeoContentSyncState(database, claims, options)

  return {
    summary,
    queries,
    landingPages,
    syncStatus: syncState
  }
}

export async function getSeoContentSyncState(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: { now?: () => string } = {}
): Promise<SeoSyncStatus> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const latestSync = await database
    .prepare(
      `SELECT data_through_date, created_at
       FROM seo_content_performance_metrics
       ORDER BY sync_date DESC, created_at DESC
       LIMIT 1`
    )
    .first<{ data_through_date: string; created_at: string }>()

  if (!latestSync) {
    return {
      status: 'never',
      dataThroughDate: null,
      lastSyncAt: null
    }
  }

  return {
    status: 'synced',
    dataThroughDate: latestSync.data_through_date,
    lastSyncAt: latestSync.created_at
  }
}
