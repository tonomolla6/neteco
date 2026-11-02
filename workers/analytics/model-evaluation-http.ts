import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  evaluateModelGate,
  getExplainabilityReport,
  getModelEvaluationSummary,
  recordOfflineEvaluation,
  recordOnlineEvaluation,
  registerMlModel,
  runAiGoldenSetEvaluation,
  ModelEvaluationError
} from './model-evaluation'

export interface ModelEvaluationHttpDependencies {
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

export function ownsModelEvaluationNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/ai\/(?:models|evaluations)(?:\/|$)/.test(value)) {
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

function serverNow(deps: ModelEvaluationHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function resolveClaims(
  request: Request,
  deps: ModelEvaluationHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) return deps.claimsResolver(request)
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

export async function handleModelEvaluationHttp(
  request: Request,
  deps: ModelEvaluationHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsModelEvaluationNamespace(path)) return null

  const method = request.method
  const now = serverNow(deps)

  try {
    const claims = await resolveClaims(request, deps)
    if (!claims) return errorResponse('unauthorized', 401)

    // 1. Model Registry
    if (path === '/api/admin/ai/models') {
      if (method === 'GET') {
        const rows = await deps.database.prepare(`SELECT * FROM ml_model_registry ORDER BY created_at DESC`).all<{
          id: string
          model_name: string
          model_version: string
          model_type: string
          status: string
          objective: string
          weights_json: string
          fallback_strategy: string
          version: number
          created_at: string
          updated_at: string
        }>()

        const models = (rows.results || []).map((r) => ({
          id: r.id,
          modelName: r.model_name,
          modelVersion: r.model_version,
          modelType: r.model_type,
          status: r.status,
          objective: r.objective,
          weights: JSON.parse(r.weights_json),
          fallbackStrategy: r.fallback_strategy,
          version: r.version,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }))

        return jsonResponse({ models })
      }

      if (method === 'POST') {
        const body = (await request.json().catch(() => null)) as {
          id: string
          modelName: string
          modelVersion: string
          modelType:
            'repurchase_propensity' | 'margin_recommendation' | 'catalog_copilot_assistant' | 'churn_propensity'
          objective: 'margin_retention' | 'conversion_margin' | 'factuality_safety'
          weights: { margin: number; retention: number; clicks: number }
          fallbackStrategy: 'static_bestsellers' | 'category_margin_top' | 'rules_safety_default'
        } | null

        if (!body || !body.id || !body.modelName) {
          return errorResponse('invalid_input', 400)
        }

        const model = await registerMlModel(deps.database, {
          actorId: claims.identityId,
          now,
          input: body
        })
        return jsonResponse({ model }, 201)
      }
    }

    // 2. Offline Evaluation Record
    if (path === '/api/admin/ai/evaluations/offline' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        modelId: string
        metrics: {
          rocAuc: number
          precisionAtK: number
          recallAtK: number
          simulatedMarginLiftPercent: number
        }
        driftPsi: number
        biasDisparateImpact: number
        sampleSize: number
      } | null

      if (!body || !body.modelId) return errorResponse('invalid_input', 400)

      const evaluation = await recordOfflineEvaluation(deps.database, {
        actorId: claims.identityId,
        now,
        modelId: body.modelId,
        metrics: body.metrics,
        driftPsi: body.driftPsi,
        biasDisparateImpact: body.biasDisparateImpact,
        sampleSize: body.sampleSize
      })
      return jsonResponse({ evaluation }, 201)
    }

    // 3. Online Evaluation Record
    if (path === '/api/admin/ai/evaluations/online' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        modelId: string
        metrics: {
          ctr: number
          conversionRate: number
          retentionLiftPercent?: number
          marginLiftPercent?: number
        }
        driftPsi: number
        biasDisparateImpact: number
        sampleSize: number
      } | null

      if (!body || !body.modelId) return errorResponse('invalid_input', 400)

      const evaluation = await recordOnlineEvaluation(deps.database, {
        actorId: claims.identityId,
        now,
        modelId: body.modelId,
        metrics: body.metrics,
        driftPsi: body.driftPsi,
        biasDisparateImpact: body.biasDisparateImpact,
        sampleSize: body.sampleSize
      })
      return jsonResponse({ evaluation }, 201)
    }

    // 4. Model Evaluation Summary
    if (path === '/api/admin/ai/evaluations/summary' && method === 'GET') {
      const modelId = url.searchParams.get('modelId')
      if (!modelId) return errorResponse('invalid_input', 400)

      const summary = await getModelEvaluationSummary(deps.database, { modelId })
      return jsonResponse({ summary })
    }

    // 5. Explainability Breakdown
    if (path === '/api/admin/ai/evaluations/explainability' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        customerId: string
        productId: string
        modelWeights: { margin: number; retention: number; clicks: number }
        features: {
          daysSinceLastOrder: number
          expectedReplenishmentCycleDays: number
          historicalSectorMarginPercent: number
          catalogPopularityScore: number
        }
      } | null

      if (!body || !body.customerId || !body.productId) {
        return errorResponse('invalid_input', 400)
      }

      const report = await getExplainabilityReport(body)
      return jsonResponse({ report })
    }

    // 6. Run Golden Set Evaluation
    if (path === '/api/admin/ai/evaluations/golden-set/run' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        modelId: string
        suiteName: string
      } | null

      if (!body || !body.modelId || !body.suiteName) {
        return errorResponse('invalid_input', 400)
      }

      const run = await runAiGoldenSetEvaluation(deps.database, {
        actorId: claims.identityId,
        modelId: body.modelId,
        suiteName: body.suiteName,
        now
      })
      return jsonResponse({ run })
    }

    // 7. Gate Check API
    if (path === '/api/admin/ai/evaluations/gate' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        factualityScore: number
        safetyScore: number
        safetyViolationsCount: number
        biasDisparateImpact: number
        driftPsi: number
        latencyP95Ms: number
        costEstimateEur: number
        fallbackTested: boolean
        fallbackPassed: boolean
      } | null

      if (!body) return errorResponse('invalid_input', 400)

      const verdict = evaluateModelGate(body)
      return jsonResponse({ verdict })
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof ModelEvaluationError) {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        unauthorized: 401,
        not_found: 404,
        model_conflict: 409,
        invalid_weights: 400,
        invalid_metrics: 400
      }
      return errorResponse(error.code, statusMap[error.code] || 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
