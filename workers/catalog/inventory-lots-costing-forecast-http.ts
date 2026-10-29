import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import type { InventoryLotsCostingAction } from '../../shared/inventory-lots-costing-forecast'
import {
  executeD1LotsCostingCommand,
  listD1Lots,
  readD1LotTraceability,
  readD1AnalyticalMarginReport,
  evaluateD1DemandForecast,
  readD1ReorderSuggestions,
  readD1DemandAnomalies,
  InventoryLotsCostingError
} from './inventory-lots-costing-forecast'

export interface InventoryLotsCostingHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}

export function ownsInventoryLotsCostingForecastNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/inventory\/(?:lots|costing|forecast|lots-costing)(?:[/\\%]|$)/.test(value) ||
      /^\/api\/admin\/inventory\/variants\/[^/]+\/(?:lots|traceability|costing|margin|forecast|suggestions|anomalies)(?:[/\\%]|$)/.test(
        value
      )
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

function status(code: string): number {
  return code === 'unauthenticated'
    ? 401
    : ['email_unverified', 'mfa_required', 'forbidden', 'csrf_rejected'].includes(code)
      ? 403
      : code === 'not_found'
        ? 404
        : code === 'invalid_input'
          ? 400
          : code === 'rate_limited'
            ? 429
            : code === 'method_not_allowed'
              ? 405
              : code === 'concurrency_conflict' || code === 'duplicate_lot_number'
                ? 409
                : 500
}

export async function handleInventoryLotsCostingForecastHttp(
  request: Request,
  deps: InventoryLotsCostingHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsInventoryLotsCostingForecastNamespace(url.pathname)) return null

  const json = (body: unknown, statusCode = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
      status: statusCode,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
        ...extra
      }
    })

  const error = (code: string, statusCode = status(code), extra?: Record<string, string>) =>
    json({ error: { code } }, statusCode, extra)

  try {
    // 1. Validate Origin / CSRF
    const isWrite = request.method !== 'GET'
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (isWrite && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      return error('csrf_rejected', 403)
    }

    // 2. Edge rate limiter
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-inventory')
    if (edge !== 'allowed') {
      return error(edge === 'limited' ? 'rate_limited' : 'unavailable', edge === 'limited' ? 429 : 503)
    }

    // 3. Verify session
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)

    // 4. Authorize initial session (Live check 1)
    const permission = isWrite ? 'inventory.write' : 'inventory.read'
    const authorize = () =>
      authorizeD1Session(deps.database, claims, permission, {
        requireMfa: true,
        ...(deps.now ? { now: deps.now() } : {})
      })
    const initialAuth = await authorize()
    if (!initialAuth.allowed) return error(initialAuth.code)

    // 5. Route dispatch
    const clock = { now: deps.now }

    // GET /api/admin/inventory/lots
    if (url.pathname === '/api/admin/inventory/lots' && request.method === 'GET') {
      const variantId = url.searchParams.get('variantId')
      if (!variantId) {
        return json({ items: [] })
      }
      const lots = await listD1Lots(deps.database, variantId)
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json({ items: lots })
    }

    // GET /api/admin/inventory/lots/traceability
    if (url.pathname === '/api/admin/inventory/lots/traceability' && request.method === 'GET') {
      const lotNumber = url.searchParams.get('lotNumber') ?? undefined
      const lotId = url.searchParams.get('lotId') ?? undefined
      const orderId = url.searchParams.get('orderId') ?? undefined
      const customerId = url.searchParams.get('customerId') ?? undefined

      const traceability = await readD1LotTraceability(deps.database, { lotNumber, lotId, orderId, customerId })
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json(traceability)
    }

    // GET /api/admin/inventory/costing/margin
    if (url.pathname === '/api/admin/inventory/costing/margin' && request.method === 'GET') {
      const variantId = url.searchParams.get('variantId') ?? undefined
      const periodStart = url.searchParams.get('periodStart') ?? '2020-01-01T00:00:00Z'
      const periodEnd = url.searchParams.get('periodEnd') ?? '2030-12-31T23:59:59Z'

      const report = await readD1AnalyticalMarginReport(deps.database, { variantId, periodStart, periodEnd })
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json(report)
    }

    // POST /api/admin/inventory/forecast/evaluate
    if (url.pathname === '/api/admin/inventory/forecast/evaluate' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        variantId?: string
        leadTimeDays?: number
        historyDays?: number
      } | null
      if (!body?.variantId) return error('invalid_input', 400)

      const evaluation = await evaluateD1DemandForecast(deps.database, body.variantId, {
        leadTimeDays: body.leadTimeDays,
        historyDays: body.historyDays,
        clock
      })
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json(evaluation)
    }

    // GET /api/admin/inventory/forecast/suggestions
    if (url.pathname === '/api/admin/inventory/forecast/suggestions' && request.method === 'GET') {
      const variantId = url.searchParams.get('variantId') ?? undefined
      const suggestions = await readD1ReorderSuggestions(deps.database, variantId)
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json({ items: suggestions })
    }

    // GET /api/admin/inventory/forecast/anomalies
    if (url.pathname === '/api/admin/inventory/forecast/anomalies' && request.method === 'GET') {
      const variantId = url.searchParams.get('variantId') ?? undefined
      const anomalies = await readD1DemandAnomalies(deps.database, variantId)
      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json({ items: anomalies })
    }

    // POST /api/admin/inventory/lots-costing/commands
    if (url.pathname === '/api/admin/inventory/lots-costing/commands' && request.method === 'POST') {
      const key = request.headers.get('idempotency-key')
      if (!key || key.length !== 36) return error('invalid_input', 400)

      // Quota check
      const quota = await consumeIdentityQuota(deps.database, {
        identityId: claims.identityId,
        scope: 'admin-inventory',
        limit: 60,
        windowSeconds: 3600,
        ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
      })
      if (!quota.allowed) {
        return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
      }

      const body = (await request.json().catch(() => null)) as {
        action: InventoryLotsCostingAction
        targetId: string
        input: unknown
      } | null
      if (!body?.action || !body.targetId || !body.input) return error('invalid_input', 400)

      const receipt = await executeD1LotsCostingCommand(
        deps.database,
        claims,
        body.action,
        body.targetId,
        body.input,
        key,
        clock
      )

      const finalAuth = await authorize()
      if (!finalAuth.allowed) return error(finalAuth.code)
      return json(receipt)
    }

    return error('invalid_input', 400)
  } catch (cause) {
    if (cause instanceof InventoryLotsCostingError) return error(cause.code)
    return error('unavailable', 500)
  }
}
