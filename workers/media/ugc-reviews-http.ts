import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { submitUgcReviewSchema, withdrawUgcReviewSchema, moderateUgcReviewSchema } from '../../shared/ugc-reviews'
import {
  listAdminUgcReviews,
  listPublicUgcReviews,
  moderateUgcPhoto,
  moderateUgcReview,
  redactUgcPii,
  requireAdmin,
  submitUgcReview,
  withdrawUgcReview,
  UgcReviewError
} from './ugc-reviews'

export interface UgcActor {
  identityId: string
  sessionVersion?: number
}

export interface UgcReviewsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  sessionProvider?: (request: Request) => Promise<UgcActor | null>
  now?: () => string
}

export function ownsUgcReviewsNamespace(pathname: string): boolean {
  return (
    /^\/api\/products\/[^/]+\/ugc-reviews(?:\/.*)?$/.test(pathname) ||
    /^\/api\/ugc-reviews\/[^/]+\/withdraw$/.test(pathname) ||
    /^\/api\/admin\/ugc-reviews(?:\/.*)?$/.test(pathname)
  )
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

function errorResponse(code: string, status = 400): Response {
  return jsonResponse({ error: { code } }, status)
}

async function resolveActor(request: Request, deps: UgcReviewsHttpDependencies): Promise<UgcActor | null> {
  if (deps.sessionProvider) return deps.sessionProvider(request)

  if (!deps.sessionCookieConfiguration) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null

  const now = (deps.now ? deps.now() : new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z')
  const live = await deps.database
    .prepare(
      `SELECT 1 AS ok FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
      WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3 AND s.session_version = i.session_version
        AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4 AND i.status = 'active'`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ ok: number }>()

  return live ? { identityId: claims.identityId, sessionVersion: claims.sessionVersion } : null
}

export async function handleUgcReviewsHttp(
  request: Request,
  deps: UgcReviewsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsUgcReviewsNamespace(path)) return null

  const now = deps.now ? deps.now() : new Date().toISOString()

  try {
    let mutationActor: UgcActor | null = null
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      mutationActor = await resolveActor(request, deps)
      if (!mutationActor) return errorResponse('unauthorized', 401)
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
        return errorResponse('csrf_rejected', 403)
      }
    }
    // 1. GET /api/products/:productId/ugc-reviews
    const publicMatch = /^\/api\/products\/([^/]+)\/ugc-reviews$/.exec(path)
    if (publicMatch && request.method === 'GET') {
      const productId = publicMatch[1]!
      const page = Number(url.searchParams.get('page') ?? '1')
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const result = await listPublicUgcReviews(deps.database, { productId, page, limit })
      return jsonResponse(result, 200, 'public, max-age=60, s-maxage=300')
    }

    // 2. POST /api/products/:productId/ugc-reviews (Submit review with photos)
    if (publicMatch && request.method === 'POST') {
      const productId = publicMatch[1]!
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const parsed = submitUgcReviewSchema.safeParse({ ...body, productId })
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const result = await submitUgcReview(deps.database, {
        actorId: actor.identityId,
        now,
        input: parsed.data
      })
      return jsonResponse(result, 201)
    }

    // 3. POST /api/ugc-reviews/:id/withdraw (Withdraw/takedown review)
    const withdrawMatch = /^\/api\/ugc-reviews\/([^/]+)\/withdraw$/.exec(path)
    if (withdrawMatch && request.method === 'POST') {
      const reviewId = withdrawMatch[1]!
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const parsed = withdrawUgcReviewSchema.safeParse({ ...body, reviewId })
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const result = await withdrawUgcReview(deps.database, {
        actorId: actor.identityId,
        now,
        input: parsed.data
      })
      return jsonResponse(result, 200)
    }

    // 4. GET /api/admin/ugc-reviews
    if (path === '/api/admin/ugc-reviews' && request.method === 'GET') {
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)
      await requireAdmin(deps.database, actor.identityId)

      const status = url.searchParams.get('status') ?? undefined
      const requirePiiReview = url.searchParams.get('pii') === 'true'
      const requireIncentiveReview = url.searchParams.get('incentive') === 'true'
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const offset = Number(url.searchParams.get('offset') ?? '0')

      const result = await listAdminUgcReviews(deps.database, {
        status,
        requirePiiReview,
        requireIncentiveReview,
        limit,
        offset
      })
      return jsonResponse(result, 200)
    }

    // 5. POST /api/admin/ugc-reviews/:id/moderate
    const moderateMatch = /^\/api\/admin\/ugc-reviews\/([^/]+)\/moderate$/.exec(path)
    if (moderateMatch && request.method === 'POST') {
      const reviewId = moderateMatch[1]!
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const parsed = moderateUgcReviewSchema.safeParse({ ...body, reviewId })
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const result = await moderateUgcReview(deps.database, {
        actorId: actor.identityId,
        now,
        input: parsed.data
      })
      return jsonResponse(result, 200)
    }

    // 6. POST /api/admin/ugc-reviews/:id/photos/:photoId/moderate
    const photoModMatch = /^\/api\/admin\/ugc-reviews\/([^/]+)\/photos\/([^/]+)\/moderate$/.exec(path)
    if (photoModMatch && request.method === 'POST') {
      const reviewId = photoModMatch[1]!
      const photoId = photoModMatch[2]!
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || !body.action) return errorResponse('invalid_input', 400)

      await moderateUgcPhoto(deps.database, {
        actorId: actor.identityId,
        reviewId,
        photoId,
        action: body.action as 'approve' | 'reject' | 'quarantine',
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        now
      })
      return jsonResponse({ success: true }, 200)
    }

    // 7. POST /api/admin/ugc-reviews/:id/redact-pii
    const redactMatch = /^\/api\/admin\/ugc-reviews\/([^/]+)\/redact-pii$/.exec(path)
    if (redactMatch && request.method === 'POST') {
      const reviewId = redactMatch[1]!
      const actor = mutationActor ?? (await resolveActor(request, deps))
      if (!actor) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || typeof body.redactedContent !== 'string') {
        return errorResponse('invalid_input', 400)
      }

      await redactUgcPii(deps.database, {
        actorId: actor.identityId,
        reviewId,
        redactedContent: body.redactedContent,
        expectedVersion: Number(body.expectedVersion ?? 1),
        commandId: typeof body.commandId === 'string' ? body.commandId : `cmd-redact-${reviewId}`,
        now
      })
      return jsonResponse({ success: true }, 200)
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof UgcReviewError) {
      if (error.code === 'invalid_input') return errorResponse(error.code, 400)
      if (error.code === 'unauthorized') return errorResponse(error.code, 401)
      if (error.code === 'forbidden') return errorResponse(error.code, 403)
      if (error.code === 'not_found') return errorResponse(error.code, 404)
      if (
        error.code === 'version_conflict' ||
        error.code === 'idempotency_conflict' ||
        error.code === 'already_withdrawn'
      ) {
        return errorResponse(error.code, 409)
      }
      return errorResponse(error.code, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
