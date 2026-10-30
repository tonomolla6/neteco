import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import {
  ContentGovernanceError,
  executeContentGovernanceCommand,
  listPublicAssets,
  readContentGovernanceOverview,
  readPublicAsset,
  readPublicTrust
} from './content-governance'

export type ContentGovernanceHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
const BASE = '/api/admin/content-governance'
const baseHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}
const privateJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      ...baseHeaders,
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...headers
    }
  })
const privateError = (code: string, status: number, headers: Record<string, string> = {}) =>
  privateJson({ error: { code } }, status, headers)
const publicJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...baseHeaders, 'CDN-Cache-Control': 'no-store' } })
const publicError = (code: string, status: number, headers: Record<string, string> = {}) =>
  Response.json({ error: { code } }, { status, headers: { ...baseHeaders, 'X-Robots-Tag': 'noindex', ...headers } })

function owns(pathname: string, pattern: RegExp) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (pattern.test(candidate)) return true
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
export const ownsContentGovernanceAdminNamespace = (pathname: string) =>
  owns(pathname, /^\/api\/admin\/content-governance(?:[/\\%]|$)/i)
export const ownsContentGovernancePublicNamespace = (pathname: string) =>
  owns(pathname, /^\/api\/content-(?:trust|assets)(?:[/\\%]|$)/i)

async function readJson(request: Request): Promise<unknown> {
  const maximum = 32 * 1024
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new ContentGovernanceError('body_too_large')
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new ContentGovernanceError('json_required')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > maximum) throw new ContentGovernanceError('body_too_large')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new ContentGovernanceError('invalid_json')
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
  unknown_page: 422,
  unknown_person: 422,
  person_archived: 422,
  date_out_of_range: 422,
  incomplete_trust: 422
}

export async function handleContentGovernanceAdminHttp(
  request: Request,
  env: ContentGovernanceHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsContentGovernanceAdminNamespace(url.pathname)) return null
  if (url.pathname !== BASE || url.search) return privateError('invalid_input', 400)
  if (!['GET', 'POST'].includes(request.method)) return privateError('method_not_allowed', 405, { Allow: 'GET, POST' })
  const write = request.method === 'POST'
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw new Error('invalid_origin')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    )
      return privateError('csrf_rejected', 403)
    if (env.AUTH_ENABLED !== 'true') return privateError('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return privateError('unauthenticated', 401)
    if (!write) return privateJson(await readContentGovernanceOverview(env.DB, claims))
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return privateError('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'content-governance-commands',
      limit: 60,
      windowSeconds: 3600
    }).catch(() => null)
    if (!quota) return privateError('abuse_control_unavailable', 503)
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed)
      return privateError('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const result = await executeContentGovernanceCommand(env.DB, claims, await readJson(request), {
      idempotencyKey: key
    })
    return privateJson(result, 200, headers)
  } catch (failure) {
    if (failure instanceof ContentGovernanceError) return privateError(failure.code, STATUS[failure.code] ?? 409)
    return privateError('service_unavailable', 503)
  }
}

export async function handleContentGovernancePublicHttp(
  request: Request,
  deps: { database: D1Database; origin: string }
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsContentGovernancePublicNamespace(url.pathname)) return null
  const trust = /^\/api\/content-trust\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname),
    list = url.pathname === '/api/content-assets',
    detail = /^\/api\/content-assets\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname)
  if (!trust && !list && !detail) return publicError('not_found', 404)
  if (request.method !== 'GET') return publicError('method_not_allowed', 405, { Allow: 'GET' })
  if (url.search) return publicError('invalid_input', 400)
  try {
    if (trust) {
      const result = await readPublicTrust(deps.database, trust[1]!, { origin: deps.origin })
      if (result.status === 'retired')
        return publicJson({ error: { code: 'retired' }, redirectTo: result.redirectTo }, 410)
      return publicJson(result)
    }
    return publicJson(list ? await listPublicAssets(deps.database) : await readPublicAsset(deps.database, detail![1]!))
  } catch (failure) {
    return failure instanceof ContentGovernanceError && failure.code === 'not_found'
      ? publicError('not_found', 404)
      : publicError('content_unavailable', 503)
  }
}
