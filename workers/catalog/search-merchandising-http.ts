import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import {
  executeSearchMerchandisingCommand,
  listSearchMerchandisingRules,
  readSearchMerchandisingHistory,
  readSearchMerchandisingReceipt,
  readSearchMerchandisingRule,
  SearchMerchandisingError
} from './search-merchandising'

export type SearchMerchandisingHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
const BASE = '/api/admin/search-merchandising'
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
export function ownsSearchMerchandisingNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/search-merchandising(?:[/\\%]|$)/.test(candidate)) return true
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
  const maximum = 16 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum),
    deadline = Date.now() + 8000
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
export async function handleSearchMerchandisingHttp(
  request: Request,
  env: SearchMerchandisingHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSearchMerchandisingNamespace(url.pathname)) return null
  const collection = url.pathname === BASE,
    item = new RegExp('^' + BASE + '/([^/]+)$').exec(url.pathname),
    history = new RegExp('^' + BASE + '/([^/]+)/history$').exec(url.pathname),
    command = new RegExp('^' + BASE + '/commands/([A-Za-z0-9._:-]{1,200})$').exec(url.pathname)
  const id = (command ? undefined : (item?.[1] ?? history?.[1])) as string | undefined
  if ((!collection && !command && !id) || (id && !catalogPolicyUuidSchema.safeParse(id).success))
    return error('invalid_input', 400)
  const allowed = collection ? ['GET', 'POST'] : command || history ? ['GET'] : ['GET', 'PUT', 'DELETE']
  if (!allowed.includes(request.method)) return error('method_not_allowed', 405, { Allow: allowed.join(', ') })
  const write = request.method !== 'GET'
  let listQuery: { page: number; perPage: number; q: string; status: 'open' | 'retired' | 'all' } | undefined
  if (collection && !write) {
    for (const key of url.searchParams.keys())
      if (!['page', 'perPage', 'q', 'status'].includes(key) || url.searchParams.getAll(key).length !== 1)
        return error('invalid_input', 400)
    const page = url.searchParams.get('page') ?? '1',
      perPage = url.searchParams.get('perPage') ?? '25',
      q = url.searchParams.get('q') ?? '',
      status = url.searchParams.get('status') ?? 'open'
    if (
      !['open', 'retired', 'all'].includes(status) ||
      !/^[1-9]\d{0,6}$/.test(page) ||
      Number(page) > 1000000 ||
      !/^[1-9]\d{0,2}$/.test(perPage) ||
      Number(perPage) > 100 ||
      q.length > 160 ||
      /[\p{Cc}\p{Cf}]/u.test(q)
    )
      return error('invalid_input', 400)
    listQuery = { page: Number(page), perPage: Number(perPage), q, status: status as 'open' | 'retired' | 'all' }
  } else if (url.searchParams.size) return error('invalid_input', 400)
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_merchandising_origin')
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
    const auth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (!write) {
      if (collection) return json(await listSearchMerchandisingRules(env.DB, claims, listQuery))
      if (command) {
        const receipt = await readSearchMerchandisingReceipt(env.DB, claims, command[1]!)
        return receipt ? json(receipt) : error('not_found', 404)
      }
      if (history) {
        const revisions = await readSearchMerchandisingHistory(env.DB, claims, id!)
        return revisions ? json(revisions) : error('not_found', 404)
      }
      const found = await readSearchMerchandisingRule(env.DB, claims, id!)
      return found ? json({ item: found }) : error('not_found', 404)
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'search-merchandising-commands',
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const body = await readBody(request)
    const receipt = await executeSearchMerchandisingCommand(env.DB, claims, body, {
      idempotencyKey: key!,
      target: collection ? null : id!,
      action: request.method === 'DELETE' ? 'retire' : 'save'
    })
    return json(receipt, collection ? 201 : 200, headers)
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof SearchMerchandisingError) {
      if (failure.code === 'unauthenticated') return error(failure.code, 401)
      if (['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)) return error(failure.code, 403)
      return error(failure.code, failure.code === 'invalid_input' ? 422 : 409)
    }
    return error('service_unavailable', 503)
  }
}
