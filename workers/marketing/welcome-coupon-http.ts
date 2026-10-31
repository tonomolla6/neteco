import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  readD1WelcomeCouponPolicy,
  updateD1WelcomeCouponPolicy,
  issueD1WelcomeCoupon,
  evaluateD1WelcomeCoupon,
  redeemD1WelcomeCoupon,
  WelcomeCouponError
} from './welcome-coupon'

export interface WelcomeCouponHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
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

export function ownsWelcomeCouponNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/welcome-coupon(?:\/|$)/.test(value) ||
      /^\/api\/marketing\/welcome-coupon(?:\/|$)/.test(value)
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

function adaptCookieConfig(
  config: SessionCookieConfiguration | { secretKey?: string; password?: string; maxAgeSeconds?: number }
): SessionCookieConfiguration {
  const cfg = config as { password?: string; secretKey?: string; maxAgeSeconds?: number }
  return {
    password: cfg?.password ?? cfg?.secretKey ?? 'synthetic-long-secret-key-at-least-32-chars!',
    maxAgeSeconds: cfg?.maxAgeSeconds ?? 86400
  }
}

async function checkAdminAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  return auth.allowed
}

export async function handleWelcomeCouponHttp(
  request: Request,
  deps: WelcomeCouponHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsWelcomeCouponNamespace(path)) {
    return null
  }

  const cookieConfig = adaptCookieConfig(deps.sessionCookieConfiguration)
  const method = request.method
  const now = deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  try {
    // 1. Admin endpoints
    if (/^\/api\/admin\/welcome-coupon(?:\/|$)/.test(path)) {
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) {
        return errorResponse('unauthenticated', 401)
      }

      const authorized = await checkAdminAuth(deps.database, claims, now)
      if (!authorized) {
        return errorResponse('forbidden', 403)
      }

      if (path === '/api/admin/welcome-coupon/policy') {
        if (method === 'GET') {
          const policy = await readD1WelcomeCouponPolicy(deps.database)
          return jsonResponse({ policy })
        }
        if (method === 'PUT') {
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
          if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)
          const updated = await updateD1WelcomeCouponPolicy(deps.database, claims.identityId, body as never, now)
          return jsonResponse({ policy: updated })
        }
        return errorResponse('method_not_allowed', 405)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Marketing / Storefront endpoints
    if (path === '/api/marketing/welcome-coupon/issue' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || !body.customerId || !body.identityId || !body.email) {
        return errorResponse('invalid_input', 400)
      }
      const grant = await issueD1WelcomeCoupon(deps.database, body as never, now)
      return jsonResponse({ grant }, 201)
    }

    if (path === '/api/marketing/welcome-coupon/evaluate' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const result = await evaluateD1WelcomeCoupon(deps.database, {
        ...(body as Record<string, unknown>),
        now
      } as never)
      return jsonResponse({ evaluation: result })
    }

    if (path === '/api/marketing/welcome-coupon/redeem' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') {
        return errorResponse('invalid_input', 400)
      }
      const redemption = await redeemD1WelcomeCoupon(deps.database, body as never, now)
      return jsonResponse({ redemption }, 200)
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    if (err instanceof WelcomeCouponError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        ineligible_existing_customer: 422,
        anti_fraud_duplicate_email: 409,
        anti_fraud_duplicate_phone: 409,
        anti_fraud_duplicate_tax_id: 409,
        anti_fraud_duplicate_fingerprint: 409,
        already_issued: 409,
        already_redeemed: 409,
        coupon_expired: 410,
        policy_paused: 403,
        min_order_unmet: 422,
        no_eligible_lines: 422
      }
      const status = statusMap[err.code] ?? 400
      return errorResponse(err.code, status)
    }
    return errorResponse('service_unavailable', 500)
  }
}
