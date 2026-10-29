import {
  upsertProductMediaGuide,
  listProductMediaGuides,
  getProductMediaGuideById,
  recordMediaUsageMetric,
  getMediaUsageStats,
  ProductMediaGuidesError
} from './product-media-guides'
import type { MediaTelemetryEventType, UpsertMediaGuideInput } from '../../shared/product-media-guides'

export interface SessionClaims {
  identityId: string
  customerId: string | null
  sessionId: string
  sessionVersion: number
}

export interface ProductMediaGuidesContext {
  database: D1Database
  now?: () => string
  sessionClaimsResolver: (request: Request) => Promise<SessionClaims | null>
}

export function ownsProductMediaGuidesNamespace(pathname: string): boolean {
  return (
    /^\/api\/products\/[^/]+\/media-guides(?:\/.*)?$/.test(pathname) ||
    /^\/api\/media\/guides\/[^/]+(?:\/.*)?$/.test(pathname) ||
    /^\/api\/admin\/media\/guides(?:\/.*)?$/.test(pathname)
  )
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  })
}

function errorResponse(code: string, status = 400): Response {
  return jsonResponse({ error: { code } }, status)
}

async function verifyAdminAuthority(db: D1Database, identityId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM identity_roles ir
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE ir.identity_id = ? AND rp.permission_code IN ('catalog.manage', 'support.manage', 'administration.manage')`
    )
    .bind(identityId)
    .first()
  return Boolean(row)
}

export async function handleProductMediaGuidesHttp(
  request: Request,
  context: ProductMediaGuidesContext
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname
  if (!ownsProductMediaGuidesNamespace(pathname)) return null

  const currentTime = context.now ? context.now() : new Date().toISOString()
  const method = request.method

  try {
    // 1. GET /api/products/:productId/media-guides (public)
    const productGuidesMatch = /^\/api\/products\/([^/]+)\/media-guides$/.exec(pathname)
    if (productGuidesMatch && method === 'GET') {
      const productId = productGuidesMatch[1]!
      const guides = await listProductMediaGuides(context.database, productId)
      return jsonResponse({ guides }, 200)
    }

    // 2. GET /api/media/guides/:guideId/telemetry (stats - admin/public aggregate)
    const telemetryStatsMatch = /^\/api\/media\/guides\/([^/]+)\/telemetry$/.exec(pathname)
    if (telemetryStatsMatch && method === 'GET') {
      const guideId = telemetryStatsMatch[1]!
      const stats = await getMediaUsageStats(context.database, guideId)
      return jsonResponse(stats, 200)
    }

    // 3. POST /api/media/guides/:guideId/telemetry (public usage telemetry)
    if (telemetryStatsMatch && method === 'POST') {
      const guideId = telemetryStatsMatch[1]!
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_input', 400)

      const result = await recordMediaUsageMetric(context.database, {
        guideId,
        eventType: body.eventType as MediaTelemetryEventType,
        playPositionSeconds: typeof body.playPositionSeconds === 'number' ? body.playPositionSeconds : undefined,
        sessionHash: typeof body.sessionHash === 'string' ? body.sessionHash : '0'.repeat(64),
        consentVerified: Boolean(body.consentVerified),
        now: currentTime
      })

      return jsonResponse(result, 200)
    }

    // 4. GET /api/media/guides/:guideId (public detail)
    const singleGuideMatch = /^\/api\/media\/guides\/([^/]+)$/.exec(pathname)
    if (singleGuideMatch && method === 'GET') {
      const guideId = singleGuideMatch[1]!
      const guide = await getProductMediaGuideById(context.database, guideId)
      if (!guide) return errorResponse('not_found', 404)
      return jsonResponse({ guide }, 200)
    }

    // 5. GET /api/admin/media/guides (admin)
    if (pathname === '/api/admin/media/guides' && method === 'GET') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const rows = await context.database
        .prepare('SELECT * FROM product_media_guides ORDER BY created_at DESC LIMIT 100')
        .all<Record<string, unknown>>()
      return jsonResponse({ guides: rows.results ?? [] }, 200)
    }

    // 6. POST /api/admin/media/guides/commands (admin: upsert/archive)
    if (pathname === '/api/admin/media/guides/commands' && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_input', 400)

      if (body.action === 'upsert_guide' && body.guide && typeof body.guide === 'object') {
        const guide = await upsertProductMediaGuide(context.database, {
          ...(body.guide as UpsertMediaGuideInput),
          actorId: claims.identityId,
          expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : 0,
          commandId: typeof body.commandId === 'string' ? body.commandId : crypto.randomUUID(),
          now: currentTime
        })
        return jsonResponse({ guide }, 200)
      }

      return errorResponse('invalid_action', 400)
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof ProductMediaGuidesError) {
      const statusMap: Record<ProductMediaGuidesError['code'], number> = {
        invalid_input: 400,
        unauthorized: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409
      }
      return errorResponse(error.code, statusMap[error.code] ?? 400)
    }
    return errorResponse('internal_error', 500)
  }
}
