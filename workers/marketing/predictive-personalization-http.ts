import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  applyCampaignOptimizationDecision,
  createCampaignOptimizationRule,
  getCampaignOptimizationReporting,
  getPersonalizationPreferences,
  getPredictiveRecommendations,
  purgePersonalizationHistory,
  recordIncrementalEvent,
  reviewOptimizationDecision,
  toggleKillSwitch,
  updatePersonalizationPreferences,
  PredictivePersonalizationError
} from './predictive-personalization'
import type {
  CampaignOptimizationRuleInput,
  PersonalizationPreferencesInput,
  ProposedOptimizationParams
} from '../../shared/predictive-personalization'

export interface PredictivePersonalizationHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
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

export function ownsPredictivePersonalizationNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/customer\/personalization(?:\/|$)/.test(value) ||
      /^\/api\/analytics\/personalization(?:\/|$)/.test(value) ||
      /^\/api\/admin\/marketing\/predictive-campaigns(?:\/|$)/.test(value)
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

function serverNow(deps: PredictivePersonalizationHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function resolveClaims(
  request: Request,
  deps: PredictivePersonalizationHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) return deps.claimsResolver(request)
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

const IncrementalEventBodySchema = z
  .object({
    id: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    variant: z.enum(['test', 'holdout']),
    eventType: z.enum(['impression', 'click', 'conversion']),
    productId: z.string().min(1).max(64).nullish(),
    marginCents: z.number().int().min(-1_000_000).max(100_000_000),
    revenueCents: z.number().int().min(0).max(100_000_000),
    contextSurface: z.enum(['home', 'cart', 'reorder_widget', 'catalog', 'email'])
  })
  .strict()

export async function handlePredictivePersonalizationHttp(
  request: Request,
  deps: PredictivePersonalizationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsPredictivePersonalizationNamespace(path)) return null

  const method = request.method
  const now = serverNow(deps)

  try {
    let administrativeClaims: VerifiedSessionClaims | null = null
    if (path.startsWith('/api/admin/marketing/predictive-campaigns')) {
      administrativeClaims = await resolveClaims(request, deps)
      if (!administrativeClaims) return errorResponse('unauthorized', 401)
      const auth = await authorizeD1Session(deps.database, administrativeClaims, 'administration.manage', {
        now,
        requireMfa: true
      })
      if (!auth.allowed) return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    }

    // 1. Customer Personalization Preferences
    if (path === '/api/customer/personalization/preferences') {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)

      const customerId = url.searchParams.get('customerId') || claims.identityId

      if (method === 'GET') {
        const preferences = await getPersonalizationPreferences(deps.database, {
          customerId,
          actorId: claims.identityId,
          now
        })
        return jsonResponse({ preferences })
      }

      if (method === 'PUT') {
        const body = (await request.json().catch(() => ({}))) as PersonalizationPreferencesInput
        const preferences = await updatePersonalizationPreferences(deps.database, {
          customerId,
          actorId: claims.identityId,
          now,
          input: body
        })
        return jsonResponse({ preferences })
      }
    }

    // 2. Customer Personalization History Purge
    if (path === '/api/customer/personalization/purge' && method === 'POST') {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => ({}))) as { customerId?: string }
      const customerId = body.customerId || claims.identityId

      const preferences = await purgePersonalizationHistory(deps.database, {
        customerId,
        actorId: claims.identityId,
        now
      })
      return jsonResponse({ preferences })
    }

    // 3. Customer Recommendations (predictive or fast fallback)
    if (path === '/api/customer/personalization/recommendations' && method === 'GET') {
      // Never trust a query parameter: it would expose another customer's consent state.
      const customerId = (await resolveClaims(request, deps))?.identityId
      const surface = url.searchParams.get('surface') || 'home'

      const result = await getPredictiveRecommendations(deps.database, {
        customerId,
        surface,
        now
      })
      return jsonResponse(result)
    }

    // 4. Analytics Incremental Event Ingestion. Authenticated only: the measurements drive
    // automatic campaign decisions, so identity and time always come from the server.
    if (path === '/api/analytics/personalization/events' && method === 'POST') {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)
      const parsed = IncrementalEventBodySchema.safeParse(await request.json().catch(() => null))
      if (!parsed.success) return errorResponse('invalid_input', 400)

      await recordIncrementalEvent(deps.database, {
        ...parsed.data,
        customerId: claims.identityId,
        now
      })
      return jsonResponse({ recorded: true }, 201)
    }

    // 5. Admin Predictive Campaign Rules
    if (path === '/api/admin/marketing/predictive-campaigns/rules') {
      const claims = administrativeClaims
      if (!claims) return errorResponse('unauthorized', 401)

      if (method === 'POST') {
        const body = (await request.json().catch(() => null)) as CampaignOptimizationRuleInput | null
        if (!body) return errorResponse('invalid_input', 400)

        const rule = await createCampaignOptimizationRule(deps.database, {
          actorId: claims.identityId,
          now,
          input: body
        })
        return jsonResponse({ rule }, 201)
      }
    }

    // 6. Admin Decision Application
    if (path === '/api/admin/marketing/predictive-campaigns/decisions' && method === 'POST') {
      const claims = administrativeClaims
      if (!claims) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as {
        ruleId: string
        decisionType: 'discount_tune' | 'budget_reallocate' | 'frequency_throttle' | 'emergency_kill'
        proposedParams: ProposedOptimizationParams
      } | null

      if (!body || !body.ruleId || !body.decisionType) {
        return errorResponse('invalid_input', 400)
      }

      const decision = await applyCampaignOptimizationDecision(deps.database, {
        ruleId: body.ruleId,
        decisionType: body.decisionType,
        proposedParams: body.proposedParams,
        now
      })
      return jsonResponse({ decision })
    }

    // 7. Admin Review Decision
    if (path === '/api/admin/marketing/predictive-campaigns/review' && method === 'POST') {
      const claims = administrativeClaims
      if (!claims) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as {
        decisionId: string
        verdict: 'approved' | 'rejected'
        notes: string
      } | null

      if (!body || !body.decisionId || !body.verdict) {
        return errorResponse('invalid_input', 400)
      }

      const decision = await reviewOptimizationDecision(deps.database, {
        decisionId: body.decisionId,
        actorId: claims.identityId,
        verdict: body.verdict,
        notes: body.notes || '',
        now
      })
      return jsonResponse({ decision })
    }

    // 8. Admin Kill Switch Toggle
    if (path === '/api/admin/marketing/predictive-campaigns/kill-switch' && method === 'POST') {
      const claims = administrativeClaims
      if (!claims) return errorResponse('unauthorized', 401)

      const body = (await request.json().catch(() => null)) as {
        ruleId: string
        active: boolean
        reason: string
      } | null

      if (!body || !body.ruleId) {
        return errorResponse('invalid_input', 400)
      }

      const rule = await toggleKillSwitch(deps.database, {
        ruleId: body.ruleId,
        actorId: claims.identityId,
        active: body.active,
        reason: body.reason || 'Admin toggle',
        now
      })
      return jsonResponse({ rule })
    }

    // 9. Admin Campaign Optimization Metrics
    if (path === '/api/admin/marketing/predictive-campaigns/metrics' && method === 'GET') {
      const claims = administrativeClaims
      if (!claims) return errorResponse('unauthorized', 401)

      const metrics = await getCampaignOptimizationReporting(deps.database, {
        actorId: claims.identityId
      })
      return jsonResponse({ metrics })
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof PredictivePersonalizationError) {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        unauthorized: 401,
        not_found: 404,
        sensitive_category_forbidden: 400,
        guardrail_max_discount_exceeded: 400,
        guardrail_budget_exceeded: 400,
        guardrail_frequency_cap_exceeded: 400,
        kill_switch_active: 409,
        cas_conflict: 409,
        invalid_input: 400
      }
      return errorResponse(error.code, statusMap[error.code] || 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
