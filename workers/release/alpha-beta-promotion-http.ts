import { ZodError } from 'zod'
import { denyUnlessAdmin, serverInstant } from './admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  createAlphaBetaPromotion,
  getAlphaBetaPromotion,
  listAlphaBetaPromotions,
  promoteAlphaBetaRelease,
  rejectAlphaBetaPromotion,
  submitAlphaBetaSignoff,
  updateAlphaBetaChecklist
} from './alpha-beta-promotion'
import { AlphaBetaPromotionError } from '../../shared/alpha-beta-promotion'

export interface AlphaBetaPromotionHttpDependencies {
  database: D1Database
  origin?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
  sessionCookieConfiguration?: SessionCookieConfiguration
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

export function ownsAlphaBetaPromotionNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/release\/alpha-beta-promotions(?:\/|$)/.test(value)) {
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

function errorResponse(code: string, status: number, message?: string): Response {
  return jsonResponse({ error: { code, message: message ?? code } }, status)
}

async function resolveClaims(
  request: Request,
  deps: AlphaBetaPromotionHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) {
    return null
  }
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

export async function handleAlphaBetaPromotionHttp(
  request: Request,
  deps: AlphaBetaPromotionHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAlphaBetaPromotionNamespace(url.pathname)) return null

  const claims = await resolveClaims(request, deps)
  if (!claims?.identityId) {
    return errorResponse('unauthenticated', 401, 'Valid session required')
  }

  const authorizedAt = deps.now ? deps.now() : serverInstant()
  const denied = await denyUnlessAdmin(deps.database, claims, ['administration.manage'], authorizedAt)
  if (denied) return errorResponse(denied.code, denied.status)

  // CSRF verification for mutations
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (deps.origin && origin && origin !== deps.origin) {
      return errorResponse('csrf_rejected', 403, 'Cross-origin request rejected')
    }
  }

  const now = deps.now ? deps.now() : serverInstant()
  const path = url.pathname.replace(/\/$/, '')

  try {
    if (request.method === 'GET') {
      if (path === '/api/admin/release/alpha-beta-promotions') {
        const promotions = await listAlphaBetaPromotions(deps.database)
        return jsonResponse(promotions, 200)
      }
      const match = path.match(/^\/api\/admin\/release\/alpha-beta-promotions\/([0-9a-f-]{36})$/)
      if (match) {
        const promo = await getAlphaBetaPromotion(deps.database, match[1])
        return jsonResponse(promo, 200)
      }
      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_json', 400, 'Invalid JSON body')

      if (path === '/api/admin/release/alpha-beta-promotions/create') {
        const created = await createAlphaBetaPromotion(deps.database, body, claims.identityId, now)
        return jsonResponse(created, 201)
      }

      if (path === '/api/admin/release/alpha-beta-promotions/update-checklist') {
        const updated = await updateAlphaBetaChecklist(deps.database, body, claims.identityId, now)
        return jsonResponse(updated, 200)
      }

      if (path === '/api/admin/release/alpha-beta-promotions/signoff') {
        const signed = await submitAlphaBetaSignoff(deps.database, body, claims.identityId, now)
        return jsonResponse(signed, 200)
      }

      if (path === '/api/admin/release/alpha-beta-promotions/promote') {
        const promoted = await promoteAlphaBetaRelease(deps.database, body, claims.identityId, now)
        return jsonResponse(promoted, 200)
      }

      if (path === '/api/admin/release/alpha-beta-promotions/reject') {
        const rejected = await rejectAlphaBetaPromotion(deps.database, body, claims.identityId, now)
        return jsonResponse(rejected, 200)
      }

      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    return errorResponse('method_not_allowed', 405, `Method ${request.method} not allowed`)
  } catch (err: unknown) {
    if (err instanceof AlphaBetaPromotionError) {
      return errorResponse(err.code, err.statusCode, err.message)
    }
    if (err instanceof ZodError) {
      return jsonResponse({ error: { code: 'validation_error', issues: err.issues } }, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
