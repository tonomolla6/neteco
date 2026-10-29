import type { HumanEvaluationCommandInput } from '../../shared/semantic-search'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import {
  searchProductsSemantically,
  executeHumanEvaluationCommand,
  listHumanEvaluations,
  computeHumanEvaluationBenchmark,
  SemanticSearchError
} from './semantic-search'
import { isValidPublicSearchQuery } from './search'

export type SemanticSearchHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>

const BASE_PUBLIC = '/api/search/semantic'
const BASE_ADMIN = '/api/admin/search-evaluations'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })

const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

export function ownsSemanticSearchNamespace(pathname: string): boolean {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (candidate === BASE_PUBLIC || candidate.startsWith(BASE_PUBLIC + '/')) return true
    if (/^\/api\/admin\/search-evaluations(?:[/\\%]|$)/.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return false
    }
  }
  return false
}

class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

async function readBody(request: Request): Promise<unknown> {
  const maximum = 16 * 1024
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new BodyError('body_too_large', 413)
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    throw new BodyError('json_required', 415)
  }
  if (!request.body) throw new BodyError('missing_body', 400)

  const reader = request.body.getReader()
  const bytes = new Uint8Array(maximum)
  const deadline = Date.now() + 8000
  let length = 0

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BodyError('body_timeout', 408)), Math.max(1, deadline - Date.now()))
        })
      ]).finally(() => clearTimeout(timer))

      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new BodyError('invalid_json', 400)
      if (next.value.byteLength > maximum - length) throw new BodyError('body_too_large', 413)
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } catch (failure) {
    void reader.cancel().catch(() => undefined)
    throw failure
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new BodyError('invalid_json', 400)
  }
}

export async function handleSemanticSearchHttp(
  request: Request,
  env: SemanticSearchHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSemanticSearchNamespace(url.pathname)) return null

  // 1. Public Semantic Search endpoint: GET /api/search/semantic?q=...
  if (url.pathname === BASE_PUBLIC) {
    if (request.method !== 'GET') {
      return error('method_not_allowed', 405, { Allow: 'GET' })
    }
    const q = url.searchParams.get('q') ?? ''
    if (!isValidPublicSearchQuery(q)) {
      return error('invalid_query', 400)
    }
    try {
      const result = await searchProductsSemantically(env.DB, q)
      return json(result)
    } catch {
      return error('internal', 500)
    }
  }

  // 2. Administrative Human Evaluation endpoints under /api/admin/search-evaluations
  const isBenchmark = url.pathname === `${BASE_ADMIN}/benchmark`
  const collection = url.pathname === BASE_ADMIN
  const itemMatch = new RegExp(`^${BASE_ADMIN}/([^/]+)$`).exec(url.pathname)
  const id = isBenchmark ? undefined : itemMatch?.[1]

  if (!isBenchmark && !collection && !id) {
    return error('invalid_input', 400)
  }

  if (id && !catalogPolicyUuidSchema.safeParse(id).success) {
    return error('invalid_input', 400)
  }

  const allowed = isBenchmark ? ['GET'] : collection ? ['GET', 'POST'] : ['GET', 'PUT', 'DELETE']

  if (!allowed.includes(request.method)) {
    return error('method_not_allowed', 405, { Allow: allowed.join(', ') })
  }

  // Security preflights: Origin/CSRF and Auth checks
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) {
      throw new Error('invalid_auth_origin')
    }

    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method !== 'GET'
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    ) {
      return error('csrf_rejected', 403)
    }

    if (env.AUTH_ENABLED !== 'true') {
      return error('service_unavailable', 503)
    }

    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)

    const auth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    // Benchmark read
    if (isBenchmark) {
      const benchmark = await computeHumanEvaluationBenchmark(env.DB, claims)
      return json(benchmark)
    }

    // Read collection
    if (collection && request.method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('perPage') ?? '25')
      const query = url.searchParams.get('q') ?? undefined
      const list = await listHumanEvaluations(env.DB, claims, { page, perPage, query })
      return json(list)
    }

    // Write operations require idempotency key and quota
    const write = request.method !== 'GET'
    if (write) {
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
        return error('invalid_idempotency_key', 400)
      }

      let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
      try {
        quota = await consumeIdentityQuota(env.DB, {
          identityId: claims.identityId,
          scope: 'search-evaluation-commands',
          limit: 60,
          windowSeconds: 3600
        })
      } catch {
        return error('abuse_control_unavailable', 503)
      }

      const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
      if (!quota.allowed) {
        return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
      }

      const body = (await readBody(request)) as unknown
      const receipt = await executeHumanEvaluationCommand(env.DB, claims, body as HumanEvaluationCommandInput, {
        idempotencyKey: key
      })
      return json(receipt, collection ? 201 : 200, headers)
    }

    return error('not_found', 404)
  } catch (failure: unknown) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof SemanticSearchError) {
      if (failure.code === 'unauthenticated') return error(failure.code, 401)
      if (['forbidden', 'mfa_required', 'email_unverified'].includes(failure.code)) return error(failure.code, 403)
      return error(failure.code, failure.code === 'invalid_input' ? 422 : 409)
    }
    return error('service_unavailable', 503)
  }
}
