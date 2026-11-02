import { ZodError } from 'zod'
import { denyUnlessAdmin, serverInstant } from './admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  getCloudflarePolicyAudit,
  listCloudflarePolicyAudits,
  runCloudflareDriftAudit,
  runCloudflarePolicyAudit
} from './cloudflare-policy'
import { CloudflarePolicyError } from '../../shared/cloudflare-policy'

export interface CloudflarePolicyHttpDependencies {
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

export function ownsCloudflarePolicyNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/release\/cloudflare-policies(?:\/|$)/.test(value)) {
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
  deps: CloudflarePolicyHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) {
    return null
  }
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

export async function handleCloudflarePolicyHttp(
  request: Request,
  deps: CloudflarePolicyHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCloudflarePolicyNamespace(url.pathname)) return null

  const claims = await resolveClaims(request, deps)
  if (!claims?.identityId) {
    return errorResponse('unauthenticated', 401, 'Valid session required')
  }

  const authorizedAt = deps.now ? deps.now() : serverInstant()
  const denied = await denyUnlessAdmin(deps.database, claims, ['administration.manage'], authorizedAt)
  if (denied) return errorResponse(denied.code, denied.status)

  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (deps.origin && origin && origin !== deps.origin) {
      return errorResponse('csrf_rejected', 403, 'Cross-origin request rejected')
    }
  }

  const path = url.pathname.replace(/\/$/, '')
  const now = deps.now ? deps.now() : serverInstant()

  try {
    if (request.method === 'GET') {
      if (path === '/api/admin/release/cloudflare-policies') {
        const audits = await listCloudflarePolicyAudits(deps.database)
        return jsonResponse(audits, 200)
      }
      const match = path.match(/^\/api\/admin\/release\/cloudflare-policies\/([0-9a-f-]{36})$/)
      if (match) {
        const audit = await getCloudflarePolicyAudit(deps.database, match[1]!)
        return jsonResponse(audit, 200)
      }
      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_json', 400, 'Invalid JSON body')

      if (path === '/api/admin/release/cloudflare-policies/audit') {
        const audit = await runCloudflarePolicyAudit(deps.database, body, claims.identityId, now)
        return jsonResponse(audit, 201)
      }

      if (path === '/api/admin/release/cloudflare-policies/drift') {
        const driftAudit = await runCloudflareDriftAudit(deps.database, body, claims.identityId, now)
        return jsonResponse(driftAudit, 201)
      }

      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    return errorResponse('method_not_allowed', 405, `Method ${request.method} not allowed`)
  } catch (err: unknown) {
    if (err instanceof CloudflarePolicyError) {
      return errorResponse(err.code, err.statusCode, err.message)
    }
    if (err instanceof ZodError) {
      return jsonResponse({ error: { code: 'validation_error', issues: err.issues } }, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
