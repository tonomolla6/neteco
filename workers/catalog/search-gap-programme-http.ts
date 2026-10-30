import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import {
  SearchGapError,
  executeSearchGapCommand,
  listSearchGapBacklog,
  listSearchGapCases,
  measureSearchGapCase
} from './search-gap-programme'

export type SearchGapHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
const BASE = '/api/admin/search-gaps'
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
export function ownsSearchGapNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/search-gaps(?:[/\\%]|$)/.test(candidate)) return true
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
async function readJson(request: Request): Promise<unknown> {
  const maximum = 8 * 1024
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new SearchGapError('body_too_large')
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new SearchGapError('json_required')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > maximum) throw new SearchGapError('body_too_large')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new SearchGapError('invalid_json')
  }
}
const STATUS: Record<string, number> = {
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  json_required: 415,
  body_too_large: 413,
  invalid_json: 400,
  invalid_input: 422,
  invalid_reference: 422,
  not_eligible: 422
}

export async function handleSearchGapHttp(request: Request, env: SearchGapHttpEnvironment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSearchGapNamespace(url.pathname)) return null
  const backlog = url.pathname === BASE + '/backlog',
    collection = url.pathname === BASE,
    measurement = /^\/api\/admin\/search-gaps\/([0-9a-f-]{36})\/measurement$/.exec(url.pathname)
  if (!backlog && !collection && !measurement) return error('invalid_input', 400)
  const allowed = collection ? ['GET', 'POST'] : ['GET']
  if (!allowed.includes(request.method)) return error('method_not_allowed', 405, { Allow: allowed.join(', ') })
  const write = request.method === 'POST'
  const known = backlog ? ['environment', 'days', 'minSearches', 'limit'] : collection && !write ? ['status'] : []
  for (const key of url.searchParams.keys())
    if (!known.includes(key) || url.searchParams.getAll(key).length !== 1) return error('invalid_input', 400)
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw new Error('invalid_origin')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    )
      return error('csrf_rejected', 403)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    if (!write) {
      if (backlog) return json(await listSearchGapBacklog(env.DB, claims, Object.fromEntries(url.searchParams)))
      if (collection) return json(await listSearchGapCases(env.DB, claims, Object.fromEntries(url.searchParams)))
      return json(await measureSearchGapCase(env.DB, claims, measurement![1]!))
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'search-gap-commands',
      limit: 60,
      windowSeconds: 3600
    }).catch(() => null)
    if (!quota) return error('abuse_control_unavailable', 503)
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const item = await executeSearchGapCommand(env.DB, claims, await readJson(request), { idempotencyKey: key })
    return json({ item }, 200, headers)
  } catch (failure) {
    if (failure instanceof SearchGapError) return error(failure.code, STATUS[failure.code] ?? 409)
    return error('service_unavailable', 503)
  }
}
