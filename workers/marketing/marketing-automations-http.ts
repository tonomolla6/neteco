import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { authorizeD1Session } from '../catalog/authorization'
import {
  readD1AutomationsPolicy,
  updateD1AutomationsPolicy,
  getD1AutomationsOverview,
  dispatchD1WelcomeStep,
  evaluateD1Winback,
  dispatchD1Postpurchase,
  readD1CustomerPreferences,
  saveD1CustomerPreferences
} from './marketing-automations'

export interface MarketingAutomationsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

export function ownsMarketingAutomationsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      value === '/api/account/marketing-preferences' ||
      value.startsWith('/api/account/marketing-preferences/') ||
      value === '/api/admin/marketing-automations' ||
      value.startsWith('/api/admin/marketing-automations/')
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

export function isAdminMarketingAutomationsPath(path: string): boolean {
  return path === '/api/admin/marketing-automations' || path.startsWith('/api/admin/marketing-automations/')
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

function statusFromCode(code: string): number {
  if (code === 'unauthenticated') return 401
  if (['mfa_required', 'forbidden', 'email_unverified', 'csrf_rejected'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'rate_limited') return 429
  if (code === 'version_conflict') return 409
  if (code === 'service_unavailable') return 503
  return 400
}

export async function handleMarketingAutomationsHttp(
  request: Request,
  deps: MarketingAutomationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsMarketingAutomationsNamespace(pathname)) return null

  if (!deps.sessionCookieConfiguration) {
    return errorResponse('service_unavailable', 503)
  }

  // CSRF validation
  if (deps.origin) {
    const requestOrigin = request.headers.get('origin')
    if ((requestOrigin && requestOrigin !== deps.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return errorResponse('csrf_rejected', 403)
    }
  }

  // Edge limiter
  if (deps.edgeLimiter && deps.rateLimitPepper && isAdminMarketingAutomationsPath(pathname)) {
    const edge = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'admin-marketing-automations'
    )
    if (edge !== 'allowed') {
      return errorResponse(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
    }
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const now =
    typeof deps.now === 'function' ? deps.now() : (deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))

  const method = request.method

  try {
    // 1. Admin endpoints
    if (isAdminMarketingAutomationsPath(pathname)) {
      const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
        requireMfa: true,
        now
      })
      if (!auth.allowed) {
        return errorResponse(auth.code, statusFromCode(auth.code))
      }

      // GET /api/admin/marketing-automations/policy
      if (pathname === '/api/admin/marketing-automations/policy' && method === 'GET') {
        const policy = await readD1AutomationsPolicy(deps.database)
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(policy)
      }

      // PUT /api/admin/marketing-automations/policy
      if (pathname === '/api/admin/marketing-automations/policy' && method === 'PUT') {
        const idempotencyKey =
          request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key') ?? crypto.randomUUID()
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return errorResponse('invalid_body', 400)

        const receipt = await updateD1AutomationsPolicy(
          deps.database,
          claims,
          body as unknown as Parameters<typeof updateD1AutomationsPolicy>[2],
          idempotencyKey,
          now
        )
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(receipt)
      }

      // GET /api/admin/marketing-automations/overview
      if (pathname === '/api/admin/marketing-automations/overview' && method === 'GET') {
        const overview = await getD1AutomationsOverview(deps.database)
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(overview)
      }

      // POST /api/admin/marketing-automations/welcome/dispatch
      if (pathname === '/api/admin/marketing-automations/welcome/dispatch' && method === 'POST') {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return errorResponse('invalid_body', 400)

        const dispatch = await dispatchD1WelcomeStep(
          deps.database,
          claims,
          body as unknown as Parameters<typeof dispatchD1WelcomeStep>[2],
          now
        )
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(dispatch)
      }

      // POST /api/admin/marketing-automations/winback/evaluate
      if (pathname === '/api/admin/marketing-automations/winback/evaluate' && method === 'POST') {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body || !body.customerId) return errorResponse('invalid_body', 400)
        const idempotencyKey =
          (body.idempotencyKey as string) ??
          request.headers.get('Idempotency-Key') ??
          request.headers.get('idempotency-key') ??
          crypto.randomUUID()

        const evaluation = await evaluateD1Winback(deps.database, claims, String(body.customerId), idempotencyKey, now)
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(evaluation)
      }

      // POST /api/admin/marketing-automations/postpurchase/dispatch
      if (pathname === '/api/admin/marketing-automations/postpurchase/dispatch' && method === 'POST') {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body || !body.orderId) return errorResponse('invalid_body', 400)
        const idempotencyKey =
          (body.idempotencyKey as string) ??
          request.headers.get('Idempotency-Key') ??
          request.headers.get('idempotency-key') ??
          crypto.randomUUID()

        const dispatches = await dispatchD1Postpurchase(
          deps.database,
          claims,
          String(body.orderId),
          idempotencyKey,
          now
        )
        const recheck = await authorizeD1Session(deps.database, claims, 'administration.manage', {
          requireMfa: true,
          now
        })
        if (!recheck.allowed) return errorResponse(recheck.code, statusFromCode(recheck.code))
        return jsonResponse(dispatches)
      }

      return errorResponse('not_found', 404)
    }

    // 2. Customer account marketing preferences
    if (pathname === '/api/account/marketing-preferences') {
      const identity = await deps.database
        .prepare(`SELECT customer_id FROM identities WHERE id = ? AND status = 'active'`)
        .bind(claims.identityId)
        .first<{ customer_id: string | null }>()

      if (!identity || !identity.customer_id) {
        return errorResponse('customer_profile_required', 403)
      }

      const customerId = identity.customer_id

      if (method === 'GET') {
        const pref = await readD1CustomerPreferences(deps.database, customerId)
        return jsonResponse(
          pref ?? {
            customerId,
            preferredCategories: [],
            frequency: 'weekly',
            channel: 'email',
            technicalContentOptIn: true,
            version: 0,
            updatedAt: now
          }
        )
      }

      if (method === 'PUT') {
        const idempotencyKey =
          request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key') ?? crypto.randomUUID()
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return errorResponse('invalid_body', 400)

        const receipt = await saveD1CustomerPreferences(
          deps.database,
          claims,
          customerId,
          body as unknown as Parameters<typeof saveD1CustomerPreferences>[3],
          idempotencyKey,
          now
        )
        return jsonResponse(receipt)
      }

      return errorResponse('method_not_allowed', 405)
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      const code = (err as { code: string }).code
      return errorResponse(code, statusFromCode(code))
    }
    if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
      return jsonResponse({ error: { code: 'invalid_input', details: (err as { issues: unknown[] }).issues } }, 400)
    }
    return errorResponse('internal_error', 500)
  }
}
