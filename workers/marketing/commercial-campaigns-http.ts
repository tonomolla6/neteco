import {
  createCommercialCampaignSchema,
  linkCampaignAssetSchema,
  updateCommercialCampaignSchema
} from '../../shared/commercial-campaigns'
import {
  createCommercialCampaign,
  updateCommercialCampaign,
  linkCampaignAsset,
  unlinkCampaignAsset,
  getCommercialCampaignDetail,
  listCommercialCampaigns,
  getCommercialCalendarFeed,
  detectCampaignConflictsInPeriod,
  CommercialCampaignError
} from './commercial-campaigns'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1AdminCookie } from '../auth/admin-session'

export interface CommercialCampaignsHttpDeps {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
}

export function ownsCommercialCampaignsNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/admin/campaigns')
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })
}

export async function handleCommercialCampaignsHttp(
  request: Request,
  deps: CommercialCampaignsHttpDeps
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCommercialCampaignsNamespace(url.pathname)) return null

  // Origin / CSRF checks
  const originHeader = request.headers.get('origin')
  if (originHeader && originHeader !== deps.origin) {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  // Session verification
  const authorization = await authorizeD1AdminCookie(request, {
    database: deps.database,
    configuration: deps.sessionCookieConfiguration,
    permissions: ['campaigns.manage', 'administration.manage'],
    now: deps.now?.()
  })
  if (!authorization.allowed) return jsonResponse({ error: { code: authorization.code } }, authorization.status)
  const { claims } = authorization

  try {
    // 1. GET calendar
    if (request.method === 'GET' && url.pathname === '/api/admin/campaigns/calendar') {
      const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7)
      const feed = await getCommercialCalendarFeed(deps.database, { month, actorId: claims.identityId })
      return jsonResponse(feed)
    }

    // 2. GET conflicts
    if (request.method === 'GET' && url.pathname === '/api/admin/campaigns/conflicts') {
      const startAt = url.searchParams.get('startAt') ?? new Date().toISOString()
      const endAt = url.searchParams.get('endAt') ?? new Date(Date.now() + 30 * 86400000).toISOString()
      const conflicts = await detectCampaignConflictsInPeriod(deps.database, {
        startAt,
        endAt,
        actorId: claims.identityId
      })
      return jsonResponse({ conflicts })
    }

    // 3. GET campaign list or POST campaign create
    if (url.pathname === '/api/admin/campaigns') {
      if (request.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined
        const targetAudience = url.searchParams.get('targetAudience') ?? undefined
        const campaigns = await listCommercialCampaigns(deps.database, {
          status,
          targetAudience,
          actorId: claims.identityId
        })
        return jsonResponse({ campaigns })
      }

      if (request.method === 'POST') {
        const body: unknown = await request.json().catch(() => null)
        const parsed = createCommercialCampaignSchema.safeParse(body)
        if (!parsed.success) {
          return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
        }

        const created = await createCommercialCampaign(deps.database, {
          commandId: parsed.data.commandId,
          actorId: claims.identityId,
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description,
          channelType: parsed.data.channelType,
          targetAudience: parsed.data.targetAudience,
          priority: parsed.data.priority,
          budgetLimitCents: parsed.data.budgetLimitCents,
          startAt: parsed.data.startAt,
          endAt: parsed.data.endAt
        })
        return jsonResponse(created, 201)
      }
    }

    // 4. Match /api/admin/campaigns/:id/assets[/:assetId]
    const assetMatch = /^\/api\/admin\/campaigns\/([0-9a-f-]+)\/assets(?:\/([0-9a-f-]+))?$/.exec(url.pathname)
    if (assetMatch?.[1]) {
      const campaignId = assetMatch[1]
      const assetId = assetMatch[2]

      if (request.method === 'POST' && !assetId) {
        const body: unknown = await request.json().catch(() => null)
        const parsed = linkCampaignAssetSchema.safeParse({ ...(body as object), campaignId })
        if (!parsed.success) {
          return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
        }

        const linked = await linkCampaignAsset(deps.database, {
          commandId: parsed.data.commandId,
          actorId: claims.identityId,
          campaignId,
          assetType: parsed.data.assetType,
          assetId: parsed.data.assetId,
          assetName: parsed.data.assetName,
          placementOrSlot: parsed.data.placementOrSlot,
          startAt: parsed.data.startAt,
          endAt: parsed.data.endAt,
          config: parsed.data.config
        })
        return jsonResponse(linked, 201)
      }

      if (request.method === 'DELETE' && assetId) {
        const commandId = url.searchParams.get('commandId') ?? crypto.randomUUID()
        const res = await unlinkCampaignAsset(deps.database, {
          commandId,
          actorId: claims.identityId,
          campaignId,
          assetId
        })
        return jsonResponse(res)
      }
    }

    // 5. Match /api/admin/campaigns/:id
    const campaignMatch = /^\/api\/admin\/campaigns\/([0-9a-f-]+)$/.exec(url.pathname)
    if (campaignMatch?.[1]) {
      const campaignId = campaignMatch[1]
      if (request.method === 'GET') {
        const detail = await getCommercialCampaignDetail(deps.database, campaignId, { actorId: claims.identityId })
        return jsonResponse(detail)
      }

      if (request.method === 'PUT') {
        const body: unknown = await request.json().catch(() => null)
        const parsed = updateCommercialCampaignSchema.safeParse(body)
        if (!parsed.success) {
          return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
        }
        const updated = await updateCommercialCampaign(deps.database, {
          commandId: parsed.data.commandId,
          actorId: claims.identityId,
          campaignId,
          expectedVersion: parsed.data.expectedVersion,
          name: parsed.data.name,
          description: parsed.data.description,
          status: parsed.data.status,
          priority: parsed.data.priority,
          startAt: parsed.data.startAt,
          endAt: parsed.data.endAt
        })
        return jsonResponse(updated)
      }
    }

    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  } catch (err) {
    if (err instanceof CommercialCampaignError) {
      const status =
        err.code === 'forbidden'
          ? 403
          : err.code === 'campaign_not_found'
            ? 404
            : err.code === 'campaign_version_conflict'
              ? 409
              : 400
      return jsonResponse({ error: { code: err.code } }, status)
    }
    return jsonResponse({ error: { code: 'internal_error' } }, 500)
  }
}
