import { z } from 'zod'
import {
  returnPublicRefSchema,
  returnTransitionInputSchema,
  returnIdempotencyKeySchema,
  returnStateSchema
} from '../../shared/order-returns'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { consumeIdentityQuota } from '../auth/identity-quota'
import {
  executeD1AdminReturnCommand,
  readD1AdminReturn,
  listD1AdminReturns,
  ReturnsError,
  type ReturnsErrorCode
} from './operations'

export type ReturnsHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
export function returnsJson(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extra
    }
  })
}
export const returnsHttpError = (code: string, status: number, extra: Record<string, string> = {}) =>
  returnsJson({ error: { code } }, status, extra)
export function returnsStatus(code: ReturnsErrorCode) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (['invalid_input', 'line_not_found'].includes(code)) return 422
  return 409
}
export class ReturnsHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
export function checkReturnsOrigin(request: Request, env: ReturnsHttpEnvironment) {
  const configured = new URL(env.AUTH_ORIGIN)
  if (configured.protocol !== 'https:' || configured.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
    throw new Error('invalid_returns_origin')
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method === 'GET'
      ? request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN
      : request.headers.get('origin') !== env.AUTH_ORIGIN)
  )
    throw new ReturnsHttpError('csrf_rejected', 403)
}
export async function readReturnsBody(request: Request): Promise<unknown> {
  const maximum = 16 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum))
    throw new ReturnsHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new ReturnsHttpError('json_required', 415)
  if (!request.body) throw new ReturnsHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new ReturnsHttpError('invalid_json', 400)
      if (next.value.length > maximum - size) {
        await reader.cancel().catch(() => undefined)
        throw new ReturnsHttpError('body_too_large', 413)
      }
      bytes.set(next.value, size)
      size += next.value.length
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } catch {
    throw new ReturnsHttpError('invalid_json', 400)
  }
}
export function returnsPagination(url: URL, list = false) {
  const allowed = list ? ['page', 'perPage', 'q', 'state'] : ['page', 'perPage']
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
    throw new ReturnsHttpError('invalid_input', 400)
  const page = url.searchParams.get('page') ?? '1',
    perPage = url.searchParams.get('perPage') ?? '25'
  if (
    !/^[1-9][0-9]{0,6}$/.test(page) ||
    Number(page) > 1_000_000 ||
    !/^[1-9][0-9]?$/.test(perPage) ||
    Number(perPage) > 50
  )
    throw new ReturnsHttpError('invalid_input', 400)
  return { page: Number(page), perPage: Number(perPage) }
}
export function ownsAdminReturnsNamespace(pathname: string) {
  let path = pathname
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/returns(?:[/\\%]|$)/.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return false
      path = decoded
    } catch {
      return false
    }
  }
  return false
}

export async function handleAdminReturnsHttp(request: Request, env: ReturnsHttpEnvironment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminReturnsNamespace(url.pathname)) return null
  try {
    checkReturnsOrigin(request, env)
    const list = url.pathname === '/api/admin/returns',
      match = /^\/api\/admin\/returns\/([^/]+)$/.exec(url.pathname),
      ref = match?.[1]
    if (!list && (!ref || !returnPublicRefSchema.safeParse(ref).success)) return returnsHttpError('invalid_input', 400)
    const read = request.method === 'GET'
    if (!(read || (!list && request.method === 'PUT')))
      return returnsHttpError('method_not_allowed', 405, { Allow: list ? 'GET' : 'GET, PUT' })
    if (!read && url.searchParams.size) return returnsHttpError('invalid_input', 400)
    const page = read ? returnsPagination(url, list) : null
    const q = url.searchParams.get('q') ?? undefined,
      state = url.searchParams.get('state') ?? undefined
    if (
      (q !== undefined && !z.string().max(100).safeParse(q).success) ||
      (state !== undefined && !returnStateSchema.safeParse(state).success)
    )
      return returnsHttpError('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return returnsHttpError('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return returnsHttpError('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
    if (!auth.allowed) return returnsHttpError(auth.code, returnsStatus(auth.code))
    if (read)
      return returnsJson(
        list
          ? await listD1AdminReturns(env.DB, claims, {
              ...page!,
              ...(q === undefined ? {} : { q }),
              ...(state === undefined ? {} : { state })
            })
          : await readD1AdminReturn(env.DB, claims, ref!, page!)
      )
    const key = returnIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return returnsHttpError('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-returns',
        limit: 60,
        windowSeconds: 3600
      }),
      headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed)
      return returnsHttpError('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const cmd = returnTransitionInputSchema.safeParse(await readReturnsBody(request))
    if (!cmd.success) return returnsHttpError('invalid_input', 422)
    const receipt = await executeD1AdminReturnCommand(env.DB, claims, ref!, cmd.data, { idempotencyKey: key.data })
    const fresh = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: true })
    if (!fresh.allowed) return returnsHttpError(fresh.code, returnsStatus(fresh.code))
    return returnsJson(receipt, 200, headers)
  } catch (failure) {
    if (failure instanceof ReturnsHttpError) return returnsHttpError(failure.code, failure.status)
    if (failure instanceof ReturnsError) return returnsHttpError(failure.code, returnsStatus(failure.code))
    return returnsHttpError('service_unavailable', 503)
  }
}
