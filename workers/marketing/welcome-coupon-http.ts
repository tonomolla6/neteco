import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  readD1WelcomeCouponGrantByIdentity,
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
): SessionCookieConfiguration | null {
  const cfg = config as { password?: string; secretKey?: string; maxAgeSeconds?: number }
  // Fail closed: never fall back to a built-in session password.
  const password = cfg?.password ?? cfg?.secretKey
  if (typeof password !== 'string' || !password) return null
  return { password, maxAgeSeconds: cfg?.maxAgeSeconds ?? 86400 }
}

/** Same-origin mutation policy for storefront coupon commands (Origin is mandatory). */
function crossOriginRejected(request: Request, origin: string | undefined): boolean {
  return !origin || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site'
}

interface SessionCustomer {
  identityId: string
  customerId: string | null
  email: string
  emailVerified: boolean
}

/** Identity, customer and email always come from the verified D1 session, never from the request body. */
async function resolveSessionCustomer(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<SessionCustomer | null> {
  const row = await database
    .prepare(
      `SELECT i.id, i.email, i.customer_id, (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?4) AS email_verified
       FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
         AND s.session_version = i.session_version AND s.revoked_at IS NULL
         AND s.created_at <= ?4 AND s.expires_at > ?4 AND i.status IN ('pending', 'active')`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ id: string; email: string; customer_id: string | null; email_verified: number }>()
  if (!row) return null
  return {
    identityId: row.id,
    customerId: row.customer_id,
    email: row.email,
    emailVerified: Boolean(row.email_verified)
  }
}

const issueBodySchema = z
  .object({
    phone: z.string().min(1).max(40).optional(),
    taxId: z.string().min(1).max(32).optional()
  })
  .strict()

const redeemBodySchema = z
  .object({
    grantId: z.string().uuid(),
    couponCode: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[A-Z0-9_-]+$/),
    orderId: z.string().min(1).max(100),
    phone: z.string().min(1).max(40).optional(),
    taxId: z.string().min(1).max(32).optional(),
    deviceFingerprint: z.string().min(1).max(256).optional(),
    discountAppliedCents: z.number().int().min(0).max(100_000_000),
    grossOrderCents: z.number().int().min(0).max(100_000_000),
    referencePriceGrossCents: z.number().int().min(0).max(100_000_000)
  })
  .strict()

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
  if (!cookieConfig) return errorResponse('service_unavailable', 503)
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
    if (
      (path === '/api/marketing/welcome-coupon/issue' || path === '/api/marketing/welcome-coupon/redeem') &&
      method === 'POST'
    ) {
      if (crossOriginRejected(request, deps.origin)) return errorResponse('csrf_rejected', 403)
      const claims = await verifySessionCookie(request, cookieConfig)
      if (!claims) return errorResponse('unauthenticated', 401)
      const caller = await resolveSessionCustomer(deps.database, claims, now)
      if (!caller) return errorResponse('unauthenticated', 401)
      if (!caller.emailVerified) return errorResponse('email_unverified', 403)
      if (!caller.customerId) return errorResponse('forbidden', 403)
      const raw = await request.text().catch(() => '')
      let body: unknown = {}
      if (raw.trim()) {
        try {
          body = JSON.parse(raw)
        } catch {
          return errorResponse('invalid_input', 400)
        }
      }

      if (path === '/api/marketing/welcome-coupon/issue') {
        const parsed = issueBodySchema.safeParse(body)
        if (!parsed.success) return errorResponse('invalid_input', 400)
        // Idempotent per identity: a replay returns the grant already issued.
        const existing = await readD1WelcomeCouponGrantByIdentity(deps.database, caller.identityId)
        if (existing) return jsonResponse({ grant: existing, replayed: true }, 200)
        try {
          const grant = await issueD1WelcomeCoupon(
            deps.database,
            {
              customerId: caller.customerId,
              identityId: caller.identityId,
              email: caller.email,
              ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
              ...(parsed.data.taxId ? { taxId: parsed.data.taxId } : {})
            },
            now
          )
          return jsonResponse({ grant }, 201)
        } catch (err) {
          // Concurrent replay lost the UNIQUE race: answer with the grant that won.
          const raced = await readD1WelcomeCouponGrantByIdentity(deps.database, caller.identityId)
          if (raced) return jsonResponse({ grant: raced, replayed: true }, 200)
          throw err
        }
      }

      const parsed = redeemBodySchema.safeParse(body)
      if (!parsed.success) return errorResponse('invalid_input', 400)
      const grant = await deps.database
        .prepare('SELECT customer_id, coupon_code FROM welcome_coupon_grants WHERE id = ?1')
        .bind(parsed.data.grantId)
        .first<{ customer_id: string; coupon_code: string }>()
      if (!grant) return errorResponse('not_found', 404)
      if (grant.customer_id !== caller.customerId || grant.coupon_code !== parsed.data.couponCode) {
        return errorResponse('forbidden', 403)
      }
      const order = await deps.database
        .prepare('SELECT customer_id FROM orders WHERE id = ?1')
        .bind(parsed.data.orderId)
        .first<{ customer_id: string | null }>()
      if (!order || order.customer_id !== caller.customerId) return errorResponse('forbidden', 403)
      const redemption = await redeemD1WelcomeCoupon(
        deps.database,
        { ...parsed.data, customerId: caller.customerId, identityId: caller.identityId, email: caller.email },
        now
      )
      return jsonResponse({ redemption }, 200)
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
