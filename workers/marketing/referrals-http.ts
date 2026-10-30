import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { referralEnrollSchema } from '../../shared/referrals'
import {
  readD1ReferralPolicy,
  updateD1ReferralPolicy,
  enrollD1ReferralAdvocate,
  attributeD1ReferralOrder,
  settleD1ReferralAttributions,
  rejectD1ReferralAttribution,
  getD1CustomerReferralOverview,
  ReferralError
} from './referrals'

export interface ReferralsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  /** SEC-036 pseudonymisation pepper; referral attribution fails closed (503) without it. */
  fraudPepper?: string
  now?: string | (() => string)
}

export function ownsReferralsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      value === '/api/account/referrals' ||
      value.startsWith('/api/account/referrals/') ||
      value === '/api/admin/referrals' ||
      value.startsWith('/api/admin/referrals/')
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

export function isAdminReferralsPath(path: string): boolean {
  return path === '/api/admin/referrals' || path.startsWith('/api/admin/referrals/')
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

function mapReferralError(err: unknown) {
  if (err instanceof ReferralError) {
    switch (err.code) {
      case 'unauthenticated':
        return errorResponse('unauthenticated', 401)
      case 'forbidden':
        return errorResponse('forbidden', 403)
      case 'not_found':
        return errorResponse('not_found', 404)
      case 'security_configuration_missing':
        return errorResponse('security_configuration_missing', 503)
      case 'conflict':
        return errorResponse('conflict', 409)
      case 'version_conflict':
        return errorResponse('version_conflict', 409)
      case 'self_referral':
      case 'fraud_detected':
      case 'program_inactive':
      case 'window_not_elapsed':
      case 'invalid_input':
      default:
        return errorResponse(err.code, 400)
    }
  }
  return errorResponse('internal_error', 500)
}

export async function handleReferralsHttp(request: Request, deps: ReferralsHttpDependencies): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const now = typeof deps.now === 'function' ? deps.now() : deps.now

  let claims = null
  if (deps.sessionCookieConfiguration) {
    claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  }

  try {
    // 1. Admin endpoints
    if (isAdminReferralsPath(path)) {
      if (!claims?.identityId) {
        return errorResponse('unauthenticated', 401)
      }

      if (deps.edgeLimiter && deps.rateLimitPepper) {
        const edgeOk = await checkAdministrativeEdgeLimit(
          request,
          deps.edgeLimiter,
          deps.rateLimitPepper,
          'admin-orders'
        )
        if (!edgeOk) return errorResponse('rate_limited', 429)
      }

      if (request.method === 'GET' && path === '/api/admin/referrals/policy') {
        const policy = await readD1ReferralPolicy(deps.database)
        return jsonResponse({ policy }, 200)
      }

      if ((request.method === 'PUT' || request.method === 'PATCH') && path === '/api/admin/referrals/policy') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const policy = await updateD1ReferralPolicy(deps.database, claims, {
          ...(body as unknown as Parameters<typeof updateD1ReferralPolicy>[2]),
          now
        })
        return jsonResponse({ policy }, 200)
      }

      if (request.method === 'POST' && path === '/api/admin/referrals/settle') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const result = await settleD1ReferralAttributions(deps.database, claims, {
          commandId: typeof body.commandId === 'string' ? body.commandId : crypto.randomUUID(),
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `idem-settle-${Date.now()}`,
          now
        })
        return jsonResponse(result, 200)
      }

      if (request.method === 'POST' && path === '/api/admin/referrals/reject') {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const result = await rejectD1ReferralAttribution(deps.database, claims, {
          ...(body as unknown as Parameters<typeof rejectD1ReferralAttribution>[2]),
          now
        })
        return jsonResponse({ attribution: result }, 200)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Customer Account endpoints
    if (!claims?.identityId) {
      return errorResponse('unauthenticated', 401)
    }

    // Find customer for identity
    const identityRow = await deps.database
      .prepare(`SELECT customer_id FROM identities WHERE id = ?`)
      .bind(claims.identityId)
      .first<{ customer_id: string }>()

    const customerId = identityRow?.customer_id ?? claims.identityId

    if (request.method === 'GET' && path === '/api/account/referrals') {
      const overview = await getD1CustomerReferralOverview(deps.database, customerId)
      return jsonResponse({ overview }, 200)
    }

    if (request.method === 'POST' && path === '/api/account/referrals/enroll') {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      // Consent time is the server clock; a client-supplied consentedAt is never trusted.
      const enrolment = referralEnrollSchema.safeParse(body)
      if (!enrolment.success) return errorResponse('invalid_input', 400)
      const result = await enrollD1ReferralAdvocate(deps.database, claims, {
        termsVersion: enrolment.data.termsVersion,
        now
      })
      return jsonResponse({ enrollment: result }, 200)
    }

    if (request.method === 'POST' && path === '/api/account/referrals/attribute') {
      if (!deps.fraudPepper || deps.fraudPepper.length < 32) return errorResponse('security_configuration_missing', 503)
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      // The referee is the authenticated customer; identity and order ownership never come from the body.
      const result = await attributeD1ReferralOrder(
        deps.database,
        {
          commandId: body.commandId as string,
          idempotencyKey: body.idempotencyKey as string,
          referralCode: body.referralCode as string,
          orderId: body.orderId as string,
          refereeCustomerId: customerId,
          now
        },
        { fraudPepper: deps.fraudPepper }
      )
      return jsonResponse({ attribution: result }, 201)
    }

    return errorResponse('not_found', 404)
  } catch (err) {
    return mapReferralError(err)
  }
}
