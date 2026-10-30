import { ZodError } from 'zod'
import { denyUnlessAdmin, serverInstant } from './admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  createProgressiveRollout,
  evaluateProgressiveRollout,
  getProgressiveRollout,
  listProgressiveRollouts,
  manualRollbackProgressiveRollout,
  promoteProgressiveRolloutFull,
  recordRolloutMetrics,
  updateProgressiveRollout
} from './progressive-rollout'
import { ProgressiveRolloutError } from '../../shared/progressive-rollout'

export interface ProgressiveRolloutHttpDependencies {
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

export function ownsProgressiveRolloutNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/release\/progressive-rollouts(?:\/|$)/.test(value) ||
      /^\/api\/release\/progressive-rollouts(?:\/|$)/.test(value)
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

function errorResponse(code: string, status: number, message?: string): Response {
  return jsonResponse({ error: { code, message: message ?? code } }, status)
}

async function resolveClaims(
  request: Request,
  deps: ProgressiveRolloutHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) {
    return null
  }
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

export async function handleProgressiveRolloutHttp(
  request: Request,
  deps: ProgressiveRolloutHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProgressiveRolloutNamespace(url.pathname)) return null

  const path = url.pathname.replace(/\/$/, '')
  const now = deps.now ? deps.now() : serverInstant()

  try {
    // 1. Runtime public evaluation endpoint (no session required)
    if (path === '/api/release/progressive-rollouts/eval' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_json', 400, 'Invalid JSON body')
      const result = await evaluateProgressiveRollout(deps.database, body)
      return jsonResponse(result, 200)
    }

    // 2. Admin routes require authentication
    const claims = await resolveClaims(request, deps)
    if (!claims?.identityId) {
      return errorResponse('unauthenticated', 401, 'Valid session required')
    }

    const denied = await denyUnlessAdmin(deps.database, claims, ['administration.manage'], now)
    if (denied) return errorResponse(denied.code, denied.status)

    if (request.method !== 'GET') {
      const origin = request.headers.get('origin')
      if (deps.origin && origin && origin !== deps.origin) {
        return errorResponse('csrf_rejected', 403, 'Cross-origin request rejected')
      }
    }

    if (request.method === 'GET') {
      if (path === '/api/admin/release/progressive-rollouts') {
        const rollouts = await listProgressiveRollouts(deps.database)
        return jsonResponse(rollouts, 200)
      }
      const match = path.match(/^\/api\/admin\/release\/progressive-rollouts\/([0-9a-f-]{36})$/)
      if (match) {
        const rollout = await getProgressiveRollout(deps.database, match[1])
        return jsonResponse(rollout, 200)
      }
      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_json', 400, 'Invalid JSON body')

      if (path === '/api/admin/release/progressive-rollouts/create') {
        const created = await createProgressiveRollout(deps.database, body, claims.identityId, now)
        return jsonResponse(created, 201)
      }

      if (path === '/api/admin/release/progressive-rollouts/update') {
        const updated = await updateProgressiveRollout(deps.database, body, claims.identityId, now)
        return jsonResponse(updated, 200)
      }

      if (path === '/api/admin/release/progressive-rollouts/metrics') {
        const metricResult = await recordRolloutMetrics(deps.database, body, claims.identityId, now)
        return jsonResponse(metricResult, 200)
      }

      if (path === '/api/admin/release/progressive-rollouts/rollback') {
        const rolledBack = await manualRollbackProgressiveRollout(deps.database, body, claims.identityId, now)
        return jsonResponse(rolledBack, 200)
      }

      if (path === '/api/admin/release/progressive-rollouts/promote-full') {
        const promoted = await promoteProgressiveRolloutFull(deps.database, body, claims.identityId, now)
        return jsonResponse(promoted, 200)
      }

      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    return errorResponse('method_not_allowed', 405, `Method ${request.method} not allowed`)
  } catch (err: unknown) {
    if (err instanceof ProgressiveRolloutError) {
      return errorResponse(err.code, err.statusCode, err.message)
    }
    if (err instanceof ZodError) {
      return jsonResponse({ error: { code: 'validation_error', issues: err.issues } }, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
