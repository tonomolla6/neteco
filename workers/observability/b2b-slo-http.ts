import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  createD1B2BContractSlo,
  verifyD1OperationalCapacity,
  recordD1B2BSloEvent,
  recordD1B2BExclusion,
  generateD1ComplianceReport,
  listD1B2BContractSlos
} from './b2b-slo'
import { B2BContractSloError } from '../../shared/b2b-contract-slo'

export interface B2BContractSloHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
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

export function ownsB2BContractSloNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/observability\/b2b-slo(?:\/|$)/.test(value)) {
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

export async function handleB2BContractSloHttp(
  request: Request,
  deps: B2BContractSloHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsB2BContractSloNamespace(path)) {
    return null
  }

  // 1. Session verification
  const claims = deps.claimsResolver
    ? await deps.claimsResolver(request)
    : await verifySessionCookie(request, deps.sessionCookieConfiguration)

  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // 2. Authorization verification
  const nowIso = deps.now ? deps.now() : undefined
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    now: nowIso
  })
  if (!auth.allowed) {
    return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  }

  const send = async (data: unknown, status = 200): Promise<Response> => {
    const after = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      now: deps.now ? deps.now() : undefined
    })
    if (!after.allowed) {
      return errorResponse(after.code, after.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse(data, status)
  }

  const subPath = path.replace(/^\/api\/admin\/observability\/b2b-slo\/?/, '')

  try {
    if (request.method === 'GET') {
      if (subPath === 'contracts' || subPath === '') {
        const contracts = await listD1B2BContractSlos(deps.database)
        return await send({ contracts })
      }
      return errorResponse('not_found', 404)
    }

    if (request.method === 'POST') {
      if (subPath === 'contracts') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const contract = await createD1B2BContractSlo(deps.database, claims, body as never, { now: nowIso })
        return await send({ contract })
      }

      if (subPath === 'contracts/verify-capacity') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const contract = await verifyD1OperationalCapacity(deps.database, claims, body as never, { now: nowIso })
        return await send({ contract })
      }

      if (subPath === 'events') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const event = await recordD1B2BSloEvent(deps.database, claims, body as never, { now: nowIso })
        return await send({ event })
      }

      if (subPath === 'exclusions') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const exclusion = await recordD1B2BExclusion(deps.database, claims, body as never, { now: nowIso })
        return await send({ exclusion })
      }

      if (subPath === 'reports') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid_request', 400, 'Invalid JSON body')
        }
        const report = await generateD1ComplianceReport(deps.database, claims, body as never, { now: nowIso })
        return await send({ report })
      }

      return errorResponse('not_found', 404)
    }

    return errorResponse('method_not_allowed', 405)
  } catch (error) {
    if (error instanceof B2BContractSloError) {
      return errorResponse(error.code, error.statusCode, error.message)
    }
    return errorResponse('internal_error', 500, error instanceof Error ? error.message : 'Unknown error')
  }
}
