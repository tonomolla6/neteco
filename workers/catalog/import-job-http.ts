import {
  catalogImportJobCreateInputSchema,
  catalogImportJobPageInputSchema,
  catalogImportJobFinalizeInputSchema
} from '../../shared/catalog-import-job'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { catalogImportJobCommandInputSchema } from '../../shared/catalog-import-job-commands'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import { NativeCatalogImportError } from './native-import'
import { executeCatalogImportJobCommand } from './import-job-commands'
import {
  createCatalogImportJob,
  readCatalogImportJob,
  readCatalogImportJobReview,
  uploadCatalogImportJobPage,
  sealCatalogImportJob
} from './import-job'

type Environment = Pick<CloudflareEnv, 'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'>
const prefix = '/api/admin/catalog/import-jobs'
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
export function ownsCatalogImportJobNamespace(path: string) {
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
export async function handleCatalogImportJobHttp(request: Request, env: Environment): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogImportJobNamespace(url.pathname)) return null
  const create = url.pathname === prefix
  const detail = new RegExp('^' + prefix + '/([^/]+)(?:/(seal|review|apply|revert|pages/(0|[1-9][0-9]{0,2})))?$').exec(
    url.pathname
  )
  const id = detail?.[1],
    action = detail?.[2],
    index = detail?.[3]
  if (!create && !detail) return error('invalid_input', 400)
  if (id !== undefined && !catalogPolicyUuidSchema.safeParse(id).success) return error('invalid_input', 400)
  const method =
    create || action === 'seal' || action === 'apply' || action === 'revert'
      ? 'POST'
      : index !== undefined
        ? 'PUT'
        : 'GET'
  if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN) throw new Error('invalid_job_origin')
    if (
      (method !== 'GET'
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    let review = { offset: 0, limit: 25 }
    if (action === 'review') {
      const keys = [...url.searchParams.keys()]
      if (keys.some((key) => key !== 'offset' && key !== 'limit') || new Set(keys).size !== keys.length)
        return error('invalid_input', 400)
      const offset = url.searchParams.get('offset') ?? '0',
        limit = url.searchParams.get('limit') ?? '25'
      if (
        !/^(?:0|[1-9][0-9]{0,5})$/.test(offset) ||
        Number(offset) > 100000 ||
        !/^[1-9][0-9]?$/.test(limit) ||
        Number(limit) > 50
      )
        return error('invalid_input', 400)
      review = { offset: Number(offset), limit: Number(limit) }
    } else if (url.searchParams.size) return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    for (const permission of ['catalog.write', 'administration.manage', 'inventory.write']) {
      const auth = await authorizeD1Session(env.DB, claims, permission, { requireMfa: true })
      if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    }
    if (method === 'GET')
      return json(
        action === 'review'
          ? await readCatalogImportJobReview(env.DB, claims, id!, review)
          : await readCatalogImportJob(env.DB, claims, id!)
      )
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: index === undefined ? 'admin-catalog-import-job-commands' : 'admin-catalog-import-job-pages',
      limit: index === undefined ? 30 : 1000,
      windowSeconds: 3600
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    if (create) {
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
      const parsed = catalogImportJobCreateInputSchema.safeParse(await readBody(request, 4096))
      if (!parsed.success) return error('invalid_input', 422)
      return json(await createCatalogImportJob(env.DB, claims, parsed.data, { idempotencyKey: key }))
    }
    if (index !== undefined) {
      const parsed = catalogImportJobPageInputSchema.safeParse(await readBody(request, 900032))
      if (!parsed.success || parsed.data.index !== Number(index)) return error('invalid_input', 422)
      return json(await uploadCatalogImportJobPage(env.DB, claims, id!, parsed.data))
    }
    if (action === 'apply' || action === 'revert') {
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return error('invalid_idempotency_key', 400)
      const parsed = catalogImportJobCommandInputSchema.safeParse(await readBody(request, 4096))
      if (!parsed.success) return error('invalid_input', 422)
      return json(await executeCatalogImportJobCommand(env.DB, claims, id!, action, parsed.data, key))
    }
    const parsed = catalogImportJobFinalizeInputSchema.safeParse(await readBody(request, 4096))
    if (!parsed.success) return error('invalid_input', 422)
    return json(await sealCatalogImportJob(env.DB, claims, id!, parsed.data))
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof NativeCatalogImportError) {
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
    return error('service_unavailable', 500)
  }
}
