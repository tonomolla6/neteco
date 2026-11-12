import {
  createSeasonalSectorCampaign,
  updateSeasonalSectorCampaign,
  setSeasonalCampaignStatus,
  saveSeasonalCampaignPostmortem,
  approveSeasonalCampaignPostmortem,
  getSeasonalSectorCampaignDetail,
  listSeasonalSectorCampaigns,
  getSeasonalCampaignCalendar,
  SeasonalCampaignError,
  verifyCampaignPermission
} from './seasonal-campaigns'
import {
  type SectorType,
  type SeasonType,
  type SeasonalCampaignStatus,
  createSeasonalSectorCampaignSchema,
  updateSeasonalSectorCampaignSchema,
  saveSeasonalCampaignPostmortemSchema
} from '../../shared/seasonal-campaigns'
import { authorizeD1AdminCookie } from '../auth/admin-session'
import type { SessionCookieConfiguration } from '../auth/session-cookie'

export interface SeasonalCampaignsHttpDeps {
  database: D1Database
  now?: () => string
  actorIdFromRequest?: (request: Request) => Promise<string | null>
  sessionCookieConfiguration?: SessionCookieConfiguration | null
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

function errorResponse(code: string, status = 400): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsSeasonalCampaignsNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/admin/seasonal-campaigns')
}

export async function handleSeasonalCampaignsHttp(
  request: Request,
  deps: SeasonalCampaignsHttpDeps
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsSeasonalCampaignsNamespace(pathname)) {
    return null
  }

  const now = deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  // Identity comes only from the verified-session resolver; request headers are never trusted.
  let actorId: string | null
  if (deps.sessionCookieConfiguration !== undefined) {
    const authorization = await authorizeD1AdminCookie(request, {
      database: deps.database,
      configuration: deps.sessionCookieConfiguration,
      permissions: ['campaigns.manage', 'administration.manage'],
      now
    })
    if (!authorization.allowed) return errorResponse(authorization.code, authorization.status)
    actorId = authorization.claims.identityId
  } else {
    // Injected trusted resolver for isolated domain tests; canary supplies cookie configuration.
    actorId = deps.actorIdFromRequest ? await deps.actorIdFromRequest(request) : null
  }

  if (!actorId) {
    return errorResponse('unauthenticated', 401)
  }

  // Cross-site defense on mutating requests
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const secFetchSite = request.headers.get('sec-fetch-site')
    if (secFetchSite === 'cross-site') {
      return errorResponse('cross_site_forbidden', 403)
    }
  }

  try {
    await verifyCampaignPermission(deps.database, actorId, now)
  } catch (err) {
    if (err instanceof SeasonalCampaignError) {
      if (err.code === 'forbidden') return errorResponse('forbidden', 403)
      return errorResponse(err.code, 400)
    }
    return errorResponse('forbidden', 403)
  }

  try {
    // 1. Calendar Feed: GET /api/admin/seasonal-campaigns/calendar
    if (request.method === 'GET' && pathname === '/api/admin/seasonal-campaigns/calendar') {
      const year = url.searchParams.get('year') ? Number(url.searchParams.get('year')) : undefined
      const sector = (url.searchParams.get('sector') as SectorType) || undefined
      const season = (url.searchParams.get('season') as SeasonType) || undefined

      const calendar = await getSeasonalCampaignCalendar(deps.database, { year, sector, season })
      return jsonResponse(calendar, 200)
    }

    // 2. List: GET /api/admin/seasonal-campaigns
    if (request.method === 'GET' && pathname === '/api/admin/seasonal-campaigns') {
      const sector = (url.searchParams.get('sector') as SectorType) || undefined
      const season = (url.searchParams.get('season') as SeasonType) || undefined
      const year = url.searchParams.get('year') ? Number(url.searchParams.get('year')) : undefined
      const status = (url.searchParams.get('status') as SeasonalCampaignStatus) || undefined

      const list = await listSeasonalSectorCampaigns(deps.database, { sector, season, year, status })
      return jsonResponse({ campaigns: list }, 200)
    }

    // 3. Create: POST /api/admin/seasonal-campaigns
    if (request.method === 'POST' && pathname === '/api/admin/seasonal-campaigns') {
      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey) return errorResponse('missing_idempotency_key', 400)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_input', 400)

      const parsed = createSeasonalSectorCampaignSchema.safeParse(body)
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const input = parsed.data

      const campaign = await createSeasonalSectorCampaign(deps.database, {
        commandId: idempotencyKey,
        actorId,
        code: input.code,
        name: input.name,
        sector: input.sector,
        season: input.season,
        year: input.year,
        need: input.need,
        window: input.window,
        inventory: input.inventory,
        logistics: input.logistics,
        content: input.content,
        margin: input.margin,
        now
      })

      return jsonResponse(campaign, 201)
    }

    // 4. Detail: GET /api/admin/seasonal-campaigns/:id
    const detailMatch = pathname.match(/^\/api\/admin\/seasonal-campaigns\/([a-f0-9-]{36})$/)
    if (request.method === 'GET' && detailMatch) {
      const campaignId = detailMatch[1]!
      const detail = await getSeasonalSectorCampaignDetail(deps.database, campaignId)
      if (!detail) return errorResponse('not_found', 404)
      return jsonResponse(detail, 200)
    }

    // 5. Update: PUT /api/admin/seasonal-campaigns/:id
    if (request.method === 'PUT' && detailMatch) {
      const campaignId = detailMatch[1]!
      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey) return errorResponse('missing_idempotency_key', 400)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_input', 400)

      const parsed = updateSeasonalSectorCampaignSchema.safeParse(body)
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const input = parsed.data

      const updated = await updateSeasonalSectorCampaign(deps.database, {
        commandId: idempotencyKey,
        actorId,
        campaignId,
        expectedVersion: input.expectedVersion,
        name: input.name,
        need: input.need,
        window: input.window,
        inventory: input.inventory,
        logistics: input.logistics,
        content: input.content,
        margin: input.margin,
        now
      })

      return jsonResponse(updated, 200)
    }

    // 6. Set Status: POST /api/admin/seasonal-campaigns/:id/status
    const statusMatch = pathname.match(/^\/api\/admin\/seasonal-campaigns\/([a-f0-9-]{36})\/status$/)
    if (request.method === 'POST' && statusMatch) {
      const campaignId = statusMatch[1]!
      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey) return errorResponse('missing_idempotency_key', 400)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body.expectedVersion !== 'number' || !body.status) return errorResponse('invalid_input', 400)

      const updated = await setSeasonalCampaignStatus(deps.database, {
        commandId: idempotencyKey,
        actorId,
        campaignId,
        expectedVersion: body.expectedVersion,
        status: body.status as SeasonalCampaignStatus,
        now
      })

      return jsonResponse(updated, 200)
    }

    // 7. Save Postmortem: POST /api/admin/seasonal-campaigns/:id/postmortem
    const postmortemMatch = pathname.match(/^\/api\/admin\/seasonal-campaigns\/([a-f0-9-]{36})\/postmortem$/)
    if (request.method === 'POST' && postmortemMatch) {
      const campaignId = postmortemMatch[1]!
      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey) return errorResponse('missing_idempotency_key', 400)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_input', 400)

      const parsed = saveSeasonalCampaignPostmortemSchema.safeParse(body)
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const input = parsed.data

      const postmortem = await saveSeasonalCampaignPostmortem(deps.database, {
        commandId: idempotencyKey,
        actorId,
        campaignId,
        expectedVersion: input.expectedVersion,
        actualRevenueCents: input.actualRevenueCents,
        actualMarginBasisPoints: input.actualMarginBasisPoints,
        targetMarginAchieved: input.targetMarginAchieved,
        stockoutOccurred: input.stockoutOccurred,
        stockoutDetails: input.stockoutDetails ?? null,
        logisticsIncidentsCount: input.logisticsIncidentsCount,
        logisticsIncidentNotes: input.logisticsIncidentNotes ?? null,
        contentPerformanceScore: input.contentPerformanceScore ?? null,
        roiBasisPoints: input.roiBasisPoints ?? null,
        keyLearnings: input.keyLearnings,
        actionItems: input.actionItems,
        now
      })

      return jsonResponse(postmortem, 200)
    }

    // 8. Approve Postmortem: POST /api/admin/seasonal-campaigns/:id/postmortem/approve
    const approveMatch = pathname.match(/^\/api\/admin\/seasonal-campaigns\/([a-f0-9-]{36})\/postmortem\/approve$/)
    if (request.method === 'POST' && approveMatch) {
      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey) return errorResponse('missing_idempotency_key', 400)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || !body.postmortemId || typeof body.expectedVersion !== 'number')
        return errorResponse('invalid_input', 400)

      const approved = await approveSeasonalCampaignPostmortem(deps.database, {
        commandId: idempotencyKey,
        actorId,
        postmortemId: String(body.postmortemId),
        expectedVersion: body.expectedVersion,
        now
      })

      return jsonResponse(approved, 200)
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof SeasonalCampaignError) {
      if (error.code === 'forbidden') return errorResponse('forbidden', 403)
      if (error.code === 'not_found') return errorResponse('not_found', 404)
      if (error.code === 'version_conflict') return errorResponse('version_conflict', 409)
      return errorResponse(error.code, 400)
    }
    return errorResponse('internal_error', 500)
  }
}
