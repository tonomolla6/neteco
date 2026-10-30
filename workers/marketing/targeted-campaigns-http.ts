import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createTargetedCampaignAdmin,
  dispatchCampaignToRecipient,
  evaluateEligibleRecipients,
  getCampaignReporting,
  listActiveCustomerCampaigns,
  listTargetedCampaignsAdmin,
  recordCampaignInteraction,
  TargetedCampaignError
} from './targeted-campaigns'
import type { CreateTargetedCampaignInput } from '../../shared/targeted-campaigns'

export interface TargetedCampaignsActorClaims {
  identityId: string
  customerId?: string | null
  sessionId?: string
  sessionVersion?: number
}

export interface TargetedCampaignsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<TargetedCampaignsActorClaims | null>
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive'
}

export function ownsTargetedCampaignsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/marketing\/targeted-campaigns(?:\/|$)/.test(value) ||
      /^\/api\/customer\/targeted-campaigns(?:\/|$)/.test(value) ||
      /^\/api\/marketing\/targeted-campaigns(?:\/|$)/.test(value)
    ) {
      return true
    }
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return false
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: SECURITY_HEADERS
  })
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code } }, status)
}

function serverNow(deps: TargetedCampaignsHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function resolveClaims(
  request: Request,
  deps: TargetedCampaignsHttpDependencies
): Promise<TargetedCampaignsActorClaims | null> {
  if (deps.claimsResolver) return deps.claimsResolver(request)
  if (!deps.sessionCookieConfiguration) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null
  const identity = await deps.database
    .prepare('SELECT id, customer_id, status FROM identities WHERE id = ?1 AND status = "active"')
    .bind(claims.identityId)
    .first<{ id: string; customer_id: string | null; status: string }>()
  if (!identity) return null
  return {
    identityId: identity.id,
    customerId: identity.customer_id ?? identity.id,
    sessionId: claims.sessionId,
    sessionVersion: claims.sessionVersion
  }
}

export async function handleTargetedCampaignsHttp(
  request: Request,
  deps: TargetedCampaignsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsTargetedCampaignsNamespace(path)) return null

  const method = request.method
  const now = serverNow(deps)

  try {
    // 1. GET /api/customer/targeted-campaigns
    if (method === 'GET' && path === '/api/customer/targeted-campaigns') {
      const claims = await resolveClaims(request, deps)
      if (!claims?.customerId) return errorResponse('unauthorized', 401)
      const campaigns = await listActiveCustomerCampaigns(deps.database, {
        customerId: claims.customerId,
        now
      })
      return jsonResponse({ campaigns })
    }

    // 2. POST /api/marketing/targeted-campaigns/:id/interaction
    const interactionMatch = path.match(/^\/api\/marketing\/targeted-campaigns\/([a-zA-Z0-9_-]+)\/interaction$/)
    if (method === 'POST' && interactionMatch) {
      const campaignId = interactionMatch[1]
      const claims = await resolveClaims(request, deps)
      if (!claims?.customerId) return errorResponse('unauthorized', 401)
      const body = (await request.json().catch(() => ({}))) as {
        interactionType?: 'open' | 'click' | 'conversion'
        orderId?: string
        revenueNetCents?: number
      }
      if (!body.interactionType) return errorResponse('invalid_input', 400)
      await recordCampaignInteraction(deps.database, {
        campaignId,
        customerId: claims.customerId,
        interactionType: body.interactionType,
        orderId: body.orderId,
        revenueNetCents: body.revenueNetCents,
        now
      })
      return jsonResponse({ ok: true })
    }

    // 3. Admin endpoints: /api/admin/marketing/targeted-campaigns
    if (path.startsWith('/api/admin/marketing/targeted-campaigns')) {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)

      // POST /api/admin/marketing/targeted-campaigns
      if (method === 'POST' && path === '/api/admin/marketing/targeted-campaigns') {
        const body = (await request.json().catch(() => ({}))) as CreateTargetedCampaignInput
        const campaign = await createTargetedCampaignAdmin(deps.database, {
          actorId: claims.identityId,
          input: body,
          now
        })
        return jsonResponse({ campaign }, 201)
      }

      // GET /api/admin/marketing/targeted-campaigns
      if (method === 'GET' && path === '/api/admin/marketing/targeted-campaigns') {
        const targetType = url.searchParams.get('targetType') || undefined
        const status = url.searchParams.get('status') || undefined
        const campaigns = await listTargetedCampaignsAdmin(deps.database, {
          actorId: claims.identityId,
          filter: { targetType, status }
        })
        return jsonResponse({ campaigns })
      }

      // GET /api/admin/marketing/targeted-campaigns/:id/reporting
      const reportingMatch = path.match(/^\/api\/admin\/marketing\/targeted-campaigns\/([a-zA-Z0-9_-]+)\/reporting$/)
      if (method === 'GET' && reportingMatch) {
        const campaignId = reportingMatch[1]
        const report = await getCampaignReporting(deps.database, {
          actorId: claims.identityId,
          campaignId
        })
        return jsonResponse(report)
      }

      // GET /api/admin/marketing/targeted-campaigns/:id/eligibility
      const eligMatch = path.match(/^\/api\/admin\/marketing\/targeted-campaigns\/([a-zA-Z0-9_-]+)\/eligibility$/)
      if (method === 'GET' && eligMatch) {
        const campaignId = eligMatch[1]
        const recipients = await evaluateEligibleRecipients(deps.database, campaignId)
        return jsonResponse({ recipients })
      }

      // POST /api/admin/marketing/targeted-campaigns/:id/dispatch
      const dispatchMatch = path.match(/^\/api\/admin\/marketing\/targeted-campaigns\/([a-zA-Z0-9_-]+)\/dispatch$/)
      if (method === 'POST' && dispatchMatch) {
        const campaignId = dispatchMatch[1]
        const body = (await request.json().catch(() => ({}))) as {
          customerId?: string
          channel?: 'email' | 'portal' | 'account_manager'
        }
        if (!body.customerId) return errorResponse('invalid_input', 400)
        const dispatch = await dispatchCampaignToRecipient(deps.database, {
          campaignId,
          customerId: body.customerId,
          channel: body.channel,
          now
        })
        return jsonResponse({ dispatch }, 201)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof TargetedCampaignError) {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        unauthorized: 401,
        not_found: 404,
        code_conflict: 409,
        sede_or_hierarchy_targeting_forbidden: 422,
        consent_missing_or_suppressed: 403,
        already_dispatched: 409,
        invalid_input: 400
      }
      return errorResponse(error.code, statusMap[error.code] ?? 400)
    }
    return errorResponse('internal_error', 500)
  }
}
