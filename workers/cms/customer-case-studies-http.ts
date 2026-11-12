import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1AdminCookie } from '../auth/admin-session'
import {
  createCaseStudy,
  getCaseStudyById,
  getPublicCaseStudyBySlug,
  listAdminCaseStudies,
  listPublicCaseStudies,
  performPeriodicReview,
  publishCaseStudy,
  requireAdmin,
  updateCaseStudy,
  CaseStudyError
} from './customer-case-studies'

export interface CaseStudyActor {
  identityId: string
  sessionVersion?: number
}

export interface CustomerCaseStudiesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  sessionProvider?: (request: Request) => Promise<CaseStudyActor | null>
  now?: () => string
}

export function ownsCustomerCaseStudiesNamespace(pathname: string): boolean {
  return /^\/api\/case-studies(?:\/.*)?$/.test(pathname) || /^\/api\/admin\/case-studies(?:\/.*)?$/.test(pathname)
}

function jsonResponse(data: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl
    }
  })
}

function errorResponse(code: string, status = 400, message?: string): Response {
  return jsonResponse({ error: { code, ...(message ? { message } : {}) } }, status)
}

async function resolveActor(
  request: Request,
  deps: CustomerCaseStudiesHttpDependencies
): Promise<CaseStudyActor | null> {
  if (deps.sessionProvider) return deps.sessionProvider(request)

  if (!deps.sessionCookieConfiguration) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null

  const live = await deps.database
    .prepare("SELECT 1 AS ok FROM identities WHERE id = ?1 AND status = 'active'")
    .bind(claims.identityId)
    .first<{ ok: number }>()

  return live ? { identityId: claims.identityId, sessionVersion: claims.sessionVersion } : null
}

export async function handleCustomerCaseStudiesHttp(
  request: Request,
  deps: CustomerCaseStudiesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsCustomerCaseStudiesNamespace(path)) return null

  const now = deps.now ? deps.now() : new Date().toISOString()

  // Strict enforcement for MKT-031: explicit rejection of community comments or social features
  if (path.includes('/comments') || path.includes('/social') || path.includes('/feed')) {
    return errorResponse(
      'community_features_forbidden',
      405,
      'No se permite comunidad, comentarios ni perfiles sociales en casos de éxito (MKT-031)'
    )
  }

  try {
    if (path.startsWith('/api/admin/') && !deps.sessionProvider) {
      const authorization = await authorizeD1AdminCookie(request, {
        database: deps.database,
        configuration: deps.sessionCookieConfiguration,
        now: now.replace(/\.\d{3}Z$/, 'Z')
      })
      if (!authorization.allowed) return errorResponse(authorization.code, authorization.status)
    }
    // 1. GET /api/case-studies (Public list)
    if (path === '/api/case-studies' && request.method === 'GET') {
      const sector = url.searchParams.get('sector') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const result = await listPublicCaseStudies(deps.database, { sector, limit, offset, now })
      return jsonResponse(result, 200, 'public, max-age=300, s-maxage=600')
    }

    // 2. GET /api/case-studies/:slug (Public detail)
    const publicSlugMatch = /^\/api\/case-studies\/([^/]+)$/.exec(path)
    if (publicSlugMatch && request.method === 'GET') {
      const slug = publicSlugMatch[1]!
      const result = await getPublicCaseStudyBySlug(deps.database, slug, now)
      return jsonResponse(result, 200, 'public, max-age=300, s-maxage=600')
    }

    // 3. GET /api/admin/case-studies
    if (path === '/api/admin/case-studies' && request.method === 'GET') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)
      await requireAdmin(deps.database, actor.identityId)

      const publicationStatus = url.searchParams.get('publicationStatus') ?? undefined
      const reviewStatus = url.searchParams.get('reviewStatus') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const offset = Number(url.searchParams.get('offset') ?? '0')

      const result = await listAdminCaseStudies(deps.database, {
        publicationStatus,
        reviewStatus,
        limit,
        offset
      })
      return jsonResponse(result, 200)
    }

    // 4. POST /api/admin/case-studies (Create draft case study)
    if (path === '/api/admin/case-studies' && request.method === 'POST') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const result = await createCaseStudy(deps.database, {
        actorId: actor.identityId,
        now,
        input: body as never
      })
      return jsonResponse(result, 201)
    }

    // 5. GET /api/admin/case-studies/:id
    const adminDetailMatch = /^\/api\/admin\/case-studies\/([^/]+)$/.exec(path)
    if (adminDetailMatch && request.method === 'GET') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)
      await requireAdmin(deps.database, actor.identityId)

      const caseId = adminDetailMatch[1]!
      const result = await getCaseStudyById(deps.database, caseId)
      if (!result) return errorResponse('not_found', 404)
      return jsonResponse(result, 200)
    }

    // 6. PUT /api/admin/case-studies/:id (Update case study)
    if (adminDetailMatch && request.method === 'PUT') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)

      const caseId = adminDetailMatch[1]!
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const result = await updateCaseStudy(deps.database, {
        actorId: actor.identityId,
        now,
        input: { ...body, caseId } as never
      })
      return jsonResponse(result, 200)
    }

    // 7. POST /api/admin/case-studies/:id/publish
    const publishMatch = /^\/api\/admin\/case-studies\/([^/]+)\/publish$/.exec(path)
    if (publishMatch && request.method === 'POST') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)

      const caseId = publishMatch[1]!
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const result = await publishCaseStudy(deps.database, {
        actorId: actor.identityId,
        now,
        input: { ...body, caseId } as never
      })
      return jsonResponse(result, 200)
    }

    // 8. POST /api/admin/case-studies/:id/periodic-review
    const reviewMatch = /^\/api\/admin\/case-studies\/([^/]+)\/periodic-review$/.exec(path)
    if (reviewMatch && request.method === 'POST') {
      const actor = await resolveActor(request, deps)
      if (!actor) return errorResponse('unauthorized', 401)

      const caseId = reviewMatch[1]!
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const result = await performPeriodicReview(deps.database, {
        actorId: actor.identityId,
        now,
        input: { ...body, caseId } as never
      })
      return jsonResponse(result, 200)
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof CaseStudyError) {
      if (error.code === 'invalid_input') return errorResponse(error.code, 400)
      if (error.code === 'unauthorized') return errorResponse(error.code, 401)
      if (error.code === 'forbidden') return errorResponse(error.code, 403)
      if (error.code === 'not_found') return errorResponse(error.code, 404)
      if (error.code === 'version_conflict' || error.code === 'idempotency_conflict') {
        return errorResponse(error.code, 409)
      }
      if (error.code === 'community_features_forbidden') {
        return errorResponse(error.code, 405, 'Sin comunidad ni comentarios en casos de éxito (MKT-031)')
      }
      if (error.code === 'publish_not_allowed' || error.code === 'review_overdue') {
        return errorResponse(error.code, 422)
      }
      return errorResponse(error.code, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
