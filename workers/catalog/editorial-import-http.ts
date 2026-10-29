import { editorialPreviewInputSchema } from '../../shared/catalog-editorial-import'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import {
  EditorialImportError,
  exportEditorialTemplate,
  previewEditorialCsv,
  readEditorialPreview,
  executeEditorialCommand
} from './editorial-import'

type Environment = Pick<CloudflareEnv, 'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'>
const prefix = '/api/admin/catalog/editorial-import'
const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { ...headers, ...extra } })
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { code } }, status, extra)
export function ownsEditorialImportNamespace(path: string) {
  for (let index = 0; index < 4; index++) {
    if (path.toLowerCase().startsWith(prefix)) return true
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
class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request, maximum: number): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new BodyError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError('json_required', 415)
  if (!request.body) throw new BodyError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(maximum)
  let length = 0
  const deadline = Date.now() + 8000
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BodyError('body_timeout', 408)), Math.max(1, deadline - Date.now()))
        })
      ]).finally(() => clearTimeout(timer))
      if (next.done) break
      if (next.value.byteLength > maximum - length) throw new BodyError('body_too_large', 413)
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch (failure) {
    await reader.cancel().catch(() => undefined)
    if (failure instanceof BodyError) throw failure
    throw new BodyError('invalid_json', 400)
  } finally {
    reader.releaseLock()
  }
}
export async function handleEditorialImportHttp(request: Request, env: Environment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsEditorialImportNamespace(url.pathname)) return null
  const detail = new RegExp('^' + prefix + '/previews/([^/]+)(?:/(apply|revert))?$').exec(url.pathname)
  const template = url.pathname === prefix + '/template',
    preview = url.pathname === prefix + '/preview'
  const action = detail?.[2],
    id = detail?.[1]
  const method = template || (detail && !action) ? 'GET' : 'POST'
  if (!template && !preview && !detail) return error('invalid_input', 400)
  if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw new Error('invalid_editorial_origin')
    if (
      (method === 'POST'
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size || (id !== undefined && !catalogPolicyUuidSchema.safeParse(id).success))
      return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, 'catalog.write', { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (template)
      return new Response(Uint8Array.from(await exportEditorialTemplate(env.DB, claims)), {
        headers: {
          ...headers,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="neteco-borradores-editorial-v1.csv"'
        }
      })
    if (detail && !action) return json(await readEditorialPreview(env.DB, claims, id!))
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'admin-editorial-import',
      limit: 30,
      windowSeconds: 3600
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    if (preview) {
      const parsed = editorialPreviewInputSchema.safeParse(await readBody(request, 2_000_128))
      if (!parsed.success) return error('invalid_input', 422)
      return json(await previewEditorialCsv(env.DB, claims, new TextEncoder().encode(parsed.data.csv)))
    }
    const key = request.headers.get('idempotency-key')
    if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
    return json(
      await executeEditorialCommand(
        env.DB,
        claims,
        id!,
        action as 'apply' | 'revert',
        await readBody(request, 4096),
        key
      )
    )
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof EditorialImportError) {
      const status =
        failure.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)
            ? 403
            : failure.code === 'not_found'
              ? 404
              : failure.code === 'invalid_input'
                ? 422
                : 409
      return error(failure.code, status)
    }
    return error('service_unavailable', 503)
  }
}
