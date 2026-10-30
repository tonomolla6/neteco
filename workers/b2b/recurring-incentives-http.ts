import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  approveFiscalSettlementAdmin,
  createIncentiveAgreementAdmin,
  evaluatePeriodSettlementAdmin,
  getCustomerIncentiveOverview,
  getIncentiveAgreementByCompany,
  RecurringIncentiveError
} from './recurring-incentives'
import type { CreateIncentiveAgreementInput } from '../../shared/recurring-incentives'

export interface RecurringIncentivesActorClaims {
  identityId: string
  customerId?: string | null
  sessionId?: string
  sessionVersion?: number
}

interface EvaluateSettlementBody {
  agreementId: string
  settlementPeriod: string
  periodStart: string
  periodEnd: string
  marginAchievedBasisPoints?: number
  slaPaymentMet?: boolean
  slaOrderSizeMet?: boolean
  slaEinvoiceMet?: boolean
}

interface ApproveSettlementBody {
  creditNoteRef: string
  notes?: string
  version: number
}

export interface RecurringIncentivesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<RecurringIncentivesActorClaims | null>
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

export function ownsRecurringIncentivesNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/b2b\/recurring-incentives(?:\/|$)/.test(value) ||
      /^\/api\/b2b\/recurring-incentives(?:\/|$)/.test(value)
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

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code } }, status)
}

function serverNow(deps: RecurringIncentivesHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function resolveClaims(
  request: Request,
  deps: RecurringIncentivesHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) return deps.claimsResolver(request)
  const token = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!token) return null
  return authorizeD1Session(deps.database, token)
}

export async function handleRecurringIncentivesHttp(
  request: Request,
  deps: RecurringIncentivesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsRecurringIncentivesNamespace(path)) return null

  const method = request.method
  const now = serverNow(deps)

  try {
    // 1. GET /api/b2b/recurring-incentives/my-overview
    if (method === 'GET' && path === '/api/b2b/recurring-incentives/my-overview') {
      const claims = await resolveClaims(request, deps)
      if (!claims?.customerId) return errorResponse('unauthorized', 401)
      const overview = await getCustomerIncentiveOverview(deps.database, {
        customerId: claims.customerId
      })
      if (!overview) return errorResponse('not_found', 404)
      return jsonResponse({ overview })
    }

    // 2. Admin endpoints: /api/admin/b2b/recurring-incentives
    if (path.startsWith('/api/admin/b2b/recurring-incentives')) {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)

      // POST /api/admin/b2b/recurring-incentives/agreements
      if (method === 'POST' && path === '/api/admin/b2b/recurring-incentives/agreements') {
        const body = (await request.json().catch(() => ({}))) as CreateIncentiveAgreementInput
        const agreement = await createIncentiveAgreementAdmin(deps.database, {
          actorId: claims.identityId,
          input: body,
          now
        })
        return jsonResponse({ agreement }, 201)
      }

      // GET /api/admin/b2b/recurring-incentives/agreements/:companyId
      const agrMatch = path.match(/^\/api\/admin\/b2b\/recurring-incentives\/agreements\/([a-zA-Z0-9_-]+)$/)
      if (method === 'GET' && agrMatch) {
        const companyId = agrMatch[1]
        const agreement = await getIncentiveAgreementByCompany(deps.database, companyId)
        if (!agreement) return errorResponse('not_found', 404)
        return jsonResponse({ agreement })
      }

      // POST /api/admin/b2b/recurring-incentives/settlements/evaluate
      if (method === 'POST' && path === '/api/admin/b2b/recurring-incentives/settlements/evaluate') {
        const body = (await request.json().catch(() => ({}))) as EvaluateSettlementBody
        const settlement = await evaluatePeriodSettlementAdmin(deps.database, {
          actorId: claims.identityId,
          agreementId: body.agreementId,
          settlementPeriod: body.settlementPeriod,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          marginAchievedBasisPoints: body.marginAchievedBasisPoints ?? 2000,
          slaPaymentMet: body.slaPaymentMet ?? true,
          slaOrderSizeMet: body.slaOrderSizeMet ?? true,
          slaEinvoiceMet: body.slaEinvoiceMet ?? true,
          now
        })
        return jsonResponse({ settlement }, 201)
      }

      // POST /api/admin/b2b/recurring-incentives/settlements/:id/approve
      const appMatch = path.match(/^\/api\/admin\/b2b\/recurring-incentives\/settlements\/([a-zA-Z0-9_-]+)\/approve$/)
      if (method === 'POST' && appMatch) {
        const settlementId = appMatch[1]
        const body = (await request.json().catch(() => ({}))) as ApproveSettlementBody
        if (!body.creditNoteRef || body.version === undefined) {
          return errorResponse('invalid_input', 400)
        }
        const settlement = await approveFiscalSettlementAdmin(deps.database, {
          actorId: claims.identityId,
          settlementId,
          creditNoteRef: body.creditNoteRef,
          notes: body.notes,
          version: body.version,
          now
        })
        return jsonResponse({ settlement })
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof RecurringIncentiveError) {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        unauthorized: 401,
        not_found: 404,
        agreement_conflict: 409,
        settlement_already_exists: 409,
        version_conflict: 409,
        invalid_input: 400
      }
      return errorResponse(error.code, statusMap[error.code] ?? 400)
    }
    return errorResponse('internal_error', 500)
  }
}
