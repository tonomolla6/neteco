import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  assignD1ExperimentVariant,
  createD1Experiment,
  getD1Experiment,
  getD1ExperimentReport,
  listD1Experiments,
  pauseD1Experiment,
  recordD1ExperimentDecision,
  recordD1ExperimentEvent,
  startD1Experiment,
  updateD1Experiment
} from './experiments'
import { ExperimentsError } from '../../shared/experiments-ab-testing'

export interface ExperimentsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
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

export function ownsExperimentsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/experiments(?:\/|$)/.test(value) || /^\/api\/experiments(?:\/|$)/.test(value)) {
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

function mapErrorToResponse(error: unknown): Response {
  if (error instanceof ExperimentsError) {
    let status = 400
    if (error.code === 'unauthenticated') status = 401
    else if (error.code === 'forbidden') status = 403
    else if (error.code === 'not_found') status = 404
    else if (
      error.code === 'conflict' ||
      error.code === 'version_conflict' ||
      error.code === 'overlapping_experiment_conflict' ||
      error.code === 'experiment_already_running' ||
      error.code === 'experiment_already_concluded' ||
      error.code === 'experiment_not_running'
    ) {
      status = 409
    }
    return errorResponse(error.code, status, error.message)
  }

  return errorResponse('internal_error', 500, error instanceof Error ? error.message : 'Unknown error')
}

async function checkExperimentsAuth(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  now?: string
): Promise<boolean> {
  const auth = await authorizeD1Session(database, claims, 'experiments.manage', { now })
  if (auth.allowed) return true
  const fallbackAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  return fallbackAuth.allowed
}

export async function handleExperimentsHttp(
  request: Request,
  deps: ExperimentsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsExperimentsNamespace(path)) {
    return null
  }

  const method = request.method
  const nowIso = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Public Endpoints: No admin authentication required
  if (path === '/api/experiments/assign' && method === 'POST') {
    try {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'JSON body required')
      const result = await assignD1ExperimentVariant(deps.database, body, nowIso)
      return jsonResponse(result, 200)
    } catch (err) {
      return mapErrorToResponse(err)
    }
  }

  if (path === '/api/experiments/events' && method === 'POST') {
    try {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_input', 400, 'JSON body required')
      const result = await recordD1ExperimentEvent(deps.database, body, nowIso)
      return jsonResponse(result, 200)
    } catch (err) {
      return mapErrorToResponse(err)
    }
  }

  // Admin Endpoints: Require admin session and permissions
  if (/^\/api\/admin\/experiments(?:\/|$)/.test(path)) {
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) {
      return errorResponse('unauthenticated', 401)
    }

    const authorized = await checkExperimentsAuth(deps.database, claims, nowIso)
    if (!authorized) {
      return errorResponse('forbidden', 403)
    }

    const recheck = async (): Promise<boolean> => checkExperimentsAuth(deps.database, claims, deps.now?.())
    const idempotencyKey = request.headers.get('idempotency-key') ?? crypto.randomUUID()

    try {
      // GET /api/admin/experiments
      if (method === 'GET' && path === '/api/admin/experiments') {
        const status = url.searchParams.get('status') ?? undefined
        const owner = url.searchParams.get('owner') ?? undefined
        const surface = url.searchParams.get('surface') ?? undefined
        const segment = url.searchParams.get('segment') ?? undefined
        const search = url.searchParams.get('search') ?? undefined
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined

        const result = await listD1Experiments(deps.database, {
          status,
          owner,
          surface,
          segment,
          search,
          limit,
          offset
        })
        if (!(await recheck())) return errorResponse('forbidden', 403)
        return jsonResponse(result, 200)
      }

      // POST /api/admin/experiments
      if (method === 'POST' && path === '/api/admin/experiments') {
        const body = await request.json().catch(() => null)
        if (!body) return errorResponse('invalid_input', 400, 'JSON body required')

        const result = await createD1Experiment(deps.database, claims, body, {
          idempotencyKey,
          now: deps.now
        })
        if (!(await recheck())) return errorResponse('forbidden', 403)
        return jsonResponse(result, 201)
      }

      // Routes with :id
      const idMatch = /^\/api\/admin\/experiments\/([0-9a-f-]{36}|[a-z0-9_-]{3,80})(?:\/(start|pause|decision))?$/.exec(
        path
      )
      if (idMatch) {
        const idOrKey = idMatch[1]!
        const subAction = idMatch[2]

        // GET /api/admin/experiments/:id (experiment detail & statistical report)
        if (method === 'GET' && !subAction) {
          const experiment = await getD1Experiment(deps.database, idOrKey)
          if (!experiment) return errorResponse('not_found', 404, 'Experimento no encontrado')

          const report = await getD1ExperimentReport(deps.database, experiment.id as string, nowIso)
          if (!(await recheck())) return errorResponse('forbidden', 403)
          return jsonResponse({ experiment, report }, 200)
        }

        // PUT /api/admin/experiments/:id (update draft)
        if (method === 'PUT' && !subAction) {
          const body = await request.json().catch(() => null)
          if (!body) return errorResponse('invalid_input', 400, 'JSON body required')

          const result = await updateD1Experiment(deps.database, claims, idOrKey, body, {
            idempotencyKey,
            now: deps.now
          })
          if (!(await recheck())) return errorResponse('forbidden', 403)
          return jsonResponse(result, 200)
        }

        // POST /api/admin/experiments/:id/start
        if (method === 'POST' && subAction === 'start') {
          const body = (await request.json().catch(() => ({}))) as { expectedVersion?: number }
          const expectedVersion = body.expectedVersion ?? 1
          const result = await startD1Experiment(deps.database, claims, idOrKey, {
            expectedVersion,
            idempotencyKey,
            now: deps.now
          })
          if (!(await recheck())) return errorResponse('forbidden', 403)
          return jsonResponse(result, 200)
        }

        // POST /api/admin/experiments/:id/pause
        if (method === 'POST' && subAction === 'pause') {
          const body = (await request.json().catch(() => ({}))) as { expectedVersion?: number }
          const expectedVersion = body.expectedVersion ?? 1
          const result = await pauseD1Experiment(deps.database, claims, idOrKey, {
            expectedVersion,
            idempotencyKey,
            now: deps.now
          })
          if (!(await recheck())) return errorResponse('forbidden', 403)
          return jsonResponse(result, 200)
        }

        // POST /api/admin/experiments/:id/decision
        if (method === 'POST' && subAction === 'decision') {
          const body = await request.json().catch(() => null)
          if (!body) return errorResponse('invalid_input', 400, 'JSON body required')

          const result = await recordD1ExperimentDecision(deps.database, claims, idOrKey, body, {
            idempotencyKey,
            now: deps.now
          })
          if (!(await recheck())) return errorResponse('forbidden', 403)
          return jsonResponse(result, 200)
        }
      }

      return errorResponse('not_found', 404, 'Ruta no encontrada')
    } catch (err) {
      return mapErrorToResponse(err)
    }
  }

  return null
}
