import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { InventoryPlanningError, isUuid, type PlanningErrorCode } from './inventory-planning-core'
import {
  decidePurchaseSuggestion,
  evaluateReorderSuggestions,
  readPurchaseSuggestions,
  readReorderPolicies,
  upsertReorderPolicy
} from './inventory-reorder-purchase'
import {
  cancelCountPlan,
  createCountPlan,
  decideCountLine,
  listCountPlans,
  readCountPlan,
  requestRecount,
  startCountPlan,
  submitCount
} from './inventory-cycle-counts'
import {
  closeScanTaskShort,
  createScanTask,
  listScanTasks,
  readScanTask,
  scanBarcode
} from '../fulfillment/warehouse-barcode-validation'

export interface InventoryPlanningHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

const PREFIXES = /^\/api\/admin\/(?:inventory\/(?:reorder|cycle-counts)|warehouse\/barcode-tasks)(?:[/\\%]|$)/i

/** Decodes repeatedly so encoded traversal cannot dodge ownership of the namespace. */
export function ownsInventoryPlanningNamespace(path: string) {
  let decoded = path
  for (let depth = 0; depth < 5; depth++) {
    if (PREFIXES.test(decoded)) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return false
}

const STATUS: Record<PlanningErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  approval_self: 409,
  no_change: 409,
  root_cause_required: 409,
  invalid_state: 409,
  insufficient_stock: 409,
  service_unavailable: 503
}

class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...extra
    }
  })
}
const fail = (code: string, status: number, extra?: Record<string, string>) => json({ error: { code } }, status, extra)

async function readBody(request: Request): Promise<unknown> {
  const limit = 64 * 1024
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit))
    throw new BoundaryError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BoundaryError('json_required', 415)
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > limit) throw new BoundaryError('body_too_large', 413)
  try {
    return JSON.parse(text)
  } catch {
    throw new BoundaryError('invalid_input', 400)
  }
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'

export async function handleInventoryPlanningHttp(
  request: Request,
  deps: InventoryPlanningHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsInventoryPlanningNamespace(url.pathname)) return null
  const path = url.pathname
  const method = request.method
  const options = deps.now ? { now: deps.now() } : {}

  if (!deps.sessionCookieConfiguration) return fail('service_unavailable', 503)
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || url.origin !== deps.origin)
      return fail('service_unavailable', 503)
  } catch {
    return fail('service_unavailable', 503)
  }
  const write = method === 'POST'
  if (
    (write && request.headers.get('origin') !== deps.origin) ||
    (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return fail('csrf_rejected', 403)

  type Route = { name: string; methods: string[] }
  const m = (re: RegExp) => re.exec(path)
  let route: Route | null
  let id = ''
  const simple: Record<string, Route> = {
    '/api/admin/inventory/reorder/policies': { name: 'policies', methods: ['GET', 'POST'] },
    '/api/admin/inventory/reorder/evaluate': { name: 'evaluate', methods: ['POST'] },
    '/api/admin/inventory/reorder/suggestions': { name: 'suggestions', methods: ['GET'] },
    '/api/admin/inventory/cycle-counts': { name: 'plans', methods: ['GET', 'POST'] },
    '/api/admin/warehouse/barcode-tasks': { name: 'tasks', methods: ['GET', 'POST'] }
  }
  route = simple[path] ?? null
  let found: RegExpExecArray | null
  if (!route && (found = m(new RegExp(`^/api/admin/inventory/reorder/suggestions/${UUID}/decision$`)))) {
    route = { name: 'decision', methods: ['POST'] }
    id = found[1]!
  } else if (
    !route &&
    (found = m(new RegExp(`^/api/admin/warehouse/barcode-tasks/${UUID}(?:/(scan|close-short))?$`)))
  ) {
    route = found[2]
      ? { name: found[2] === 'scan' ? 'scan' : 'close-short', methods: ['POST'] }
      : { name: 'task', methods: ['GET'] }
    id = found[1]!
  } else if (
    !route &&
    (found = m(new RegExp(`^/api/admin/inventory/cycle-counts/${UUID}(?:/(start|count|recount|decide|cancel))?$`)))
  ) {
    route = found[2] ? { name: found[2], methods: ['POST'] } : { name: 'plan', methods: ['GET'] }
    id = found[1]!
  }
  if (!route) return fail('not_found', 404)
  if (!route.methods.includes(method)) return fail('method_not_allowed', 405, { Allow: route.methods.join(', ') })

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return fail('unauthenticated', 401)

  try {
    if (!write) {
      const status = url.searchParams.get('status') ?? undefined
      const stage = url.searchParams.get('stage') ?? undefined
      const limitRaw = url.searchParams.get('limit')
      if (limitRaw !== null && !/^[1-9][0-9]{0,2}$/.test(limitRaw)) return fail('invalid_input', 400)
      const limit = limitRaw ? Number(limitRaw) : undefined
      for (const key of url.searchParams.keys())
        if (!['status', 'stage', 'limit'].includes(key)) return fail('invalid_input', 400)
      if (status !== undefined && !/^[a-z_]{3,30}$/.test(status)) return fail('invalid_input', 400)
      if (stage !== undefined && !/^[a-z_]{3,30}$/.test(stage)) return fail('invalid_input', 400)
      const read = { ...options, limit }
      switch (route.name) {
        case 'policies':
          return json({ policies: await readReorderPolicies(deps.database, claims, read) })
        case 'suggestions':
          return json({
            suggestions: await readPurchaseSuggestions(deps.database, claims, { ...read, status: status as never })
          })
        case 'plans':
          return json({ plans: await listCountPlans(deps.database, claims, { ...read, status }) })
        case 'plan':
          return json(await readCountPlan(deps.database, claims, id, options))
        case 'tasks':
          return json({ tasks: await listScanTasks(deps.database, claims, { ...read, status, stage }) })
        default:
          return json(await readScanTask(deps.database, claims, id, options))
      }
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !isUuid(key)) return fail('invalid_input', 400)
    const body = await readBody(request)
    const db = deps.database
    switch (route.name) {
      case 'policies':
        return json(await upsertReorderPolicy(db, claims, body, key, options), 201)
      case 'evaluate':
        return json(await evaluateReorderSuggestions(db, claims, body, key, options), 201)
      case 'decision':
        return json(await decidePurchaseSuggestion(db, claims, id, body, key, options), 201)
      case 'plans':
        return json(await createCountPlan(db, claims, body, key, options), 201)
      case 'start':
        return json(await startCountPlan(db, claims, id, body, key, options), 201)
      case 'count':
        return json(await submitCount(db, claims, id, body, key, options), 201)
      case 'recount':
        return json(await requestRecount(db, claims, id, body, key, options), 201)
      case 'decide':
        return json(await decideCountLine(db, claims, id, body, key, options), 201)
      case 'cancel':
        return json(await cancelCountPlan(db, claims, id, body, key, options), 201)
      case 'tasks':
        return json(await createScanTask(db, claims, body, key, options), 201)
      case 'scan': {
        const result = await scanBarcode(db, claims, id, body, key, options)
        // A rejected scan is recorded (audit) but surfaced as a stable error so scanners beep.
        return result.outcome === 'rejected'
          ? json({ error: { code: result.code }, scan: result }, 409)
          : json(result, 201)
      }
      default:
        return json(await closeScanTaskShort(db, claims, id, body, key, options), 201)
    }
  } catch (cause) {
    if (cause instanceof BoundaryError) return fail(cause.code, cause.status)
    if (cause instanceof InventoryPlanningError) return fail(cause.code, STATUS[cause.code])
    return fail('service_unavailable', 503)
  }
}
