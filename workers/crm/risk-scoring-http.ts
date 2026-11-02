import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  calculateCustomerRiskScore,
  getCustomerScoringProfile,
  reviewCustomerRiskScore,
  evaluateScoringModelQuality
} from './risk-scoring'

export interface CustomerRiskScoringHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

export function ownsCustomerRiskScoringNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/admin/scoring/')
}

export async function handleCustomerRiskScoringHttp(
  request: Request,
  deps: CustomerRiskScoringHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsCustomerRiskScoringNamespace(pathname)) return null

  if (!deps.sessionCookieConfiguration) {
    return errorResponse('service_unavailable', 503)
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthorized', 401)
  }

  const checkAdminAuth = async () => {
    return deps.database
      .prepare(
        `SELECT 1 FROM identity_roles
         WHERE identity_id = ? AND (
           role_code IN ('admin', 'super-admin')
           OR EXISTS (SELECT 1 FROM role_permissions WHERE role_code = identity_roles.role_code AND permission_code = 'administration.manage')
         )`
      )
      .bind(claims.identityId)
      .first()
  }

  if (!(await checkAdminAuth())) {
    return errorResponse('forbidden', 403)
  }

  const method = request.method

  try {
    // GET /api/admin/scoring/quality
    if (pathname === '/api/admin/scoring/quality' && method === 'GET') {
      const quality = await evaluateScoringModelQuality(deps.database)
      if (!(await checkAdminAuth())) return errorResponse('forbidden', 403)
      return jsonResponse({ quality })
    }

    // Pattern: /api/admin/scoring/profiles/:customerId/...
    const profileMatch = pathname.match(/^\/api\/admin\/scoring\/profiles\/([^/]+)(?:\/(calculate|review))?$/)
    if (!profileMatch) return errorResponse('not_found', 404)

    const customerId = profileMatch[1]!
    const action = profileMatch[2]

    // 1. GET profile
    if (!action && method === 'GET') {
      const profile = await getCustomerScoringProfile(deps.database, customerId)
      if (!profile) return errorResponse('not_found', 404)
      if (!(await checkAdminAuth())) return errorResponse('forbidden', 403)
      return jsonResponse({ profile })
    }

    // 2. POST calculate
    if (action === 'calculate' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || !body.commercialMetrics) return errorResponse('invalid_metrics_input', 400)

      const profile = await calculateCustomerRiskScore(deps.database, {
        customerId,
        commercialMetrics: body.commercialMetrics as Parameters<
          typeof calculateCustomerRiskScore
        >[1]['commercialMetrics']
      })
      if (!(await checkAdminAuth())) return errorResponse('forbidden', 403)
      return jsonResponse({ ok: true, profile })
    }

    // 3. POST review
    if (action === 'review' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)

      const profile = await reviewCustomerRiskScore(deps.database, {
        customerId,
        analystIdentityId: claims.identityId,
        input: {
          action: (body.action as 'review' | 'override') ?? 'review',
          newRiskTier: body.newRiskTier as Parameters<typeof reviewCustomerRiskScore>[1]['input']['newRiskTier'],
          newCreditLimitCents: Number(body.newCreditLimitCents),
          justification: String(body.justification ?? '')
        }
      })
      if (!(await checkAdminAuth())) return errorResponse('forbidden', 403)
      return jsonResponse({ ok: true, profile })
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : 'scoring_operation_failed', 400)
  }
}
