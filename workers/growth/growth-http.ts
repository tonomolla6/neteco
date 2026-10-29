import { z } from 'zod'
import { checkAdministrativeEdgeLimit, canonicalAddress } from '../auth/edge-limit'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { LEAD_MAGNETS, findLeadMagnet } from '../../shared/lead-magnets'
import { BXGY_STATUSES } from '../../shared/buy-x-get-y'
import {
  createBxgyRule,
  listBxgyRules,
  previewBuyXGetY,
  recordBxgyReturn,
  setBxgyRuleStatus,
  updateBxgyRule
} from './buy-x-get-y'
import { GrowthError, authorizeAdmin, isoNow, type GrowthErrorCode, type VerifiedSessionClaims } from './common'
import { leadMagnetSummary, requestLeadMagnetCopy } from './lead-magnets'
import {
  analyzePromoExperiment,
  assignPromoSubject,
  createPromoExperiment,
  listPromoExperiments,
  recordPromoObservation,
  transitionPromoExperiment
} from './promo-experiments'

export interface GrowthHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: string | (() => string)
}

const ADMIN_PREFIX = '/api/admin/growth/'
const PUBLIC_PATHS = /^\/api\/(promotions\/buy-x-get-y\/preview|lead-magnets(\/.*)?)$/
const MAX_PUBLIC_BODY_BYTES = 4096
const MAX_ADMIN_BODY_BYTES = 65536

function decodedPath(path: string): string {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    try {
      const next = decodeURIComponent(value)
      if (next === value) break
      value = next
    } catch {
      break
    }
  }
  return value
}

export function ownsGrowthNamespace(path: string): boolean {
  const value = decodedPath(path)
  return value === ADMIN_PREFIX.slice(0, -1) || value.startsWith(ADMIN_PREFIX) || PUBLIC_PATHS.test(value)
}

const STATUS: Record<GrowthErrorCode | 'csrf_rejected' | 'method_not_allowed' | 'payload_too_large', number> = {
  invalid_input: 400,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  limit_reached: 409,
  experiment_not_running: 409,
  payload_too_large: 413,
  variant_not_available: 422,
  return_invalid: 422,
  rate_limited: 429,
  service_unavailable: 503
}

const PRIVATE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer'
}

function json(data: unknown, status = 200, headers: Record<string, string> = PRIVATE_HEADERS): Response {
  return new Response(JSON.stringify(data), { status, headers })
}
function errorResponse(code: keyof typeof STATUS | 'internal_error'): Response {
  return json({ error: { code } }, code === 'internal_error' ? 500 : STATUS[code])
}

class TooLarge extends Error {}

async function body(request: Request, maxBytes: number): Promise<unknown> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new GrowthError('invalid_input')
  }
  if (new TextEncoder().encode(text).length > maxBytes) throw new TooLarge()
  try {
    return JSON.parse(text)
  } catch {
    throw new GrowthError('invalid_input')
  }
}
const idempotencyKey = (request: Request): string => {
  const key = request.headers.get('idempotency-key')
  if (!key || key.length < 8 || key.length > 128) throw new GrowthError('invalid_input')
  return key
}

const expectedVersion = z.number().int().min(1)
const ruleUpdateBody = z.object({ expectedVersion, rule: z.unknown() }).strict()
const ruleStatusBody = z.object({ expectedVersion, status: z.enum(BXGY_STATUSES) }).strict()
const transitionBody = z.object({ action: z.enum(['start', 'stop', 'conclude']), expectedVersion }).strict()
const assignBody = z.object({ subjectKey: z.string().min(1).max(200) }).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new GrowthError('invalid_input')
  return result.data
}

async function liveCustomerId(db: D1Database, claims: VerifiedSessionClaims, now: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT i.customer_id AS customerId FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3 AND i.session_version = s.session_version
         AND i.status = 'active' AND s.revoked_at IS NULL AND s.expires_at > ?4 AND i.customer_id IS NOT NULL`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ customerId: string }>()
  return row?.customerId ?? null
}

export async function handleGrowthHttp(request: Request, deps: GrowthHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsGrowthNamespace(url.pathname)) return null
  const path = decodedPath(url.pathname)
  const method = request.method
  const now = typeof deps.now === 'function' ? deps.now() : (deps.now ?? isoNow())
  const isAdmin = path.startsWith(ADMIN_PREFIX)

  try {
    // Same-origin for every state-changing request (public and administrative).
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.get('origin')
      const required = deps.origin
      if (!required || origin !== required || request.headers.get('sec-fetch-site') === 'cross-site')
        return errorResponse('csrf_rejected')
    }
    if (isAdmin) return await handleAdmin(request, deps, path, method, now)
    return await handlePublic(request, deps, path, method, now)
  } catch (error) {
    if (error instanceof GrowthError) return errorResponse(error.code)
    if (error instanceof TooLarge) return errorResponse('payload_too_large')
    return errorResponse('internal_error')
  }
}

async function edge(
  request: Request,
  deps: GrowthHttpDependencies,
  scope: 'admin-catalog' | 'storefront-cart' | 'newsletter'
): Promise<void> {
  if (!deps.edgeLimiter || !deps.rateLimitPepper) throw new GrowthError('service_unavailable')
  const outcome = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, scope)
  if (outcome === 'limited') throw new GrowthError('rate_limited')
  if (outcome === 'unavailable') throw new GrowthError('service_unavailable')
}

async function handleAdmin(
  request: Request,
  deps: GrowthHttpDependencies,
  path: string,
  method: string,
  now: string
): Promise<Response> {
  if (!deps.sessionCookieConfiguration) return errorResponse('service_unavailable')
  await edge(request, deps, 'admin-catalog')
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return errorResponse('unauthenticated')
  await authorizeAdmin(deps.database, claims, now)
  const db = deps.database
  const segments = path.slice(ADMIN_PREFIX.length).split('/')
  const [area, id, leaf] = segments
  const send = async (status: number, data: unknown) => {
    await authorizeAdmin(db, claims, now) // authorization is live after the work too
    return json(data, status)
  }

  if (area === 'bxgy-rules') {
    if (segments.length === 1) {
      if (method === 'GET') return send(200, { rules: await listBxgyRules(db, claims, now) })
      if (method === 'POST')
        return send(
          201,
          await createBxgyRule(db, claims, await body(request, MAX_ADMIN_BODY_BYTES), idempotencyKey(request), now)
        )
    }
    if (segments.length === 2 && method === 'PUT') {
      const input = parse(ruleUpdateBody, await body(request, MAX_ADMIN_BODY_BYTES))
      return send(
        200,
        await updateBxgyRule(db, claims, id!, input.rule, input.expectedVersion, idempotencyKey(request), now)
      )
    }
    if (segments.length === 3 && leaf === 'status' && method === 'POST') {
      const input = parse(ruleStatusBody, await body(request, MAX_ADMIN_BODY_BYTES))
      return send(
        200,
        await setBxgyRuleStatus(db, claims, id!, input.status, input.expectedVersion, idempotencyKey(request), now)
      )
    }
  }
  if (area === 'bxgy-returns' && segments.length === 1 && method === 'POST')
    return send(200, await recordBxgyReturn(db, claims, await body(request, MAX_ADMIN_BODY_BYTES), now))

  if (area === 'promo-experiments') {
    if (segments.length === 1) {
      if (method === 'GET') return send(200, { experiments: await listPromoExperiments(db, claims, now) })
      if (method === 'POST')
        return send(
          201,
          await createPromoExperiment(
            db,
            claims,
            await body(request, MAX_ADMIN_BODY_BYTES),
            idempotencyKey(request),
            now
          )
        )
    }
    if (segments.length === 3 && method === 'GET' && leaf === 'analysis')
      return send(200, await analyzePromoExperiment(db, claims, id!, now))
    if (segments.length === 3 && method === 'POST' && leaf === 'transition') {
      const input = parse(transitionBody, await body(request, MAX_ADMIN_BODY_BYTES))
      return send(
        200,
        await transitionPromoExperiment(
          db,
          claims,
          id!,
          input.action,
          input.expectedVersion,
          idempotencyKey(request),
          now
        )
      )
    }
    if (segments.length === 3 && method === 'POST' && leaf === 'assign') {
      const input = parse(assignBody, await body(request, MAX_ADMIN_BODY_BYTES))
      return send(200, await assignPromoSubject(db, id!, input.subjectKey, now))
    }
    if (segments.length === 3 && method === 'POST' && leaf === 'observations') {
      await recordPromoObservation(db, id!, await body(request, MAX_ADMIN_BODY_BYTES), now)
      return send(201, { recorded: true })
    }
  }
  if (area === 'lead-magnets' && id === 'summary' && segments.length === 2 && method === 'GET')
    return send(200, { summary: await leadMagnetSummary(db, claims, now) })

  const known = ['bxgy-rules', 'bxgy-returns', 'promo-experiments', 'lead-magnets']
  return errorResponse(known.includes(area ?? '') ? 'method_not_allowed' : 'not_found')
}

const CATALOGUE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff'
}

async function handlePublic(
  request: Request,
  deps: GrowthHttpDependencies,
  path: string,
  method: string,
  now: string
): Promise<Response> {
  if (path === '/api/lead-magnets' || /^\/api\/lead-magnets\/[a-z0-9-]+$/.test(path)) {
    if (method !== 'GET') return errorResponse('method_not_allowed')
    if (path === '/api/lead-magnets')
      return json(
        { magnets: LEAD_MAGNETS.map(({ slug, kind, title, description }) => ({ slug, kind, title, description })) },
        200,
        CATALOGUE_HEADERS
      )
    const magnet = findLeadMagnet(path.slice('/api/lead-magnets/'.length))
    return magnet ? json(magnet, 200, CATALOGUE_HEADERS) : errorResponse('not_found')
  }

  const copy = /^\/api\/lead-magnets\/([a-z0-9-]+)\/request-copy$/.exec(path)
  if (copy) {
    if (method !== 'POST') return errorResponse('method_not_allowed')
    await edge(request, deps, 'newsletter')
    const input = await body(request, MAX_PUBLIC_BODY_BYTES)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new GrowthError('invalid_input')
    const result = await requestLeadMagnetCopy(
      deps.database,
      { ...(input as Record<string, unknown>), magnetSlug: copy[1] },
      {
        pepper: deps.rateLimitPepper ?? '',
        address: canonicalAddress(request.headers.get('cf-connecting-ip')),
        publicOrigin: deps.origin ?? ''
      },
      now
    )
    return json(result, 202)
  }

  if (path === '/api/promotions/buy-x-get-y/preview') {
    if (method !== 'POST') return errorResponse('method_not_allowed')
    await edge(request, deps, 'storefront-cart')
    const input = await body(request, MAX_PUBLIC_BODY_BYTES)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new GrowthError('invalid_input')
    let customerId: string | null = null
    if (deps.sessionCookieConfiguration) {
      const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
      if (claims) customerId = await liveCustomerId(deps.database, claims, now)
    }
    const preview = await previewBuyXGetY(deps.database, { ...(input as Record<string, unknown>), customerId }, now)
    // Cost, margin and the internal snapshot never leave the server.
    const { eligible, reason, applications, lines, totals } = preview.evaluation
    return json({
      rule: preview.rule && { code: preview.rule.code },
      evaluation: { eligible, reason, applications, lines, totals }
    })
  }
  return errorResponse('not_found')
}
