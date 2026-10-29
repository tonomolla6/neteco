import { CMS_BODY_BYTES, cmsIdempotencyKeySchema, type CmsAction } from '../../shared/cms-commands'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from '../catalog/authorization'
import { cmsPublicationInputSchema } from '../../shared/cms-publication'
import { readCmsPublicationState, executeCmsPublicationCommand, CmsPublicationError } from './publication'
import type { CmsPublicationDependencies } from './publication-gate'
import { cmsPreviewConfigured } from './preview'
import { readCmsEditorialCalendar } from './calendar'
import {
  CMS_ACTION_PERMISSIONS,
  CMS_READ_PERMISSION,
  CmsDraftError,
  executeD1CmsDraftCommand,
  listD1CmsPages,
  getD1CmsPage
} from './drafts'

export type CmsDraftHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
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
}
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)
/** Own the entire historical admin-content namespace, including encoded aliases.
 * Unsupported publication actions cannot escape into the Node CMS. */
export function ownsCmsNamespace(pathname: string) {
  let value = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/content(?:[/\\%]|$)/.test(value)) return true
    try {
      const next = decodeURIComponent(value)
      if (next === value) return false
      value = next
    } catch {
      return false
    }
  }
  return false
}
class CmsHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CMS_BODY_BYTES))
    throw new CmsHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new CmsHttpError('json_required', 415)
  if (!request.body) throw new CmsHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(CMS_BODY_BYTES)
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw new CmsHttpError('invalid_json', 400)
      if (chunk.value.byteLength > CMS_BODY_BYTES - length) {
        await reader.cancel().catch(() => undefined)
        throw new CmsHttpError('body_too_large', 413)
      }
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new CmsHttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new CmsHttpError('invalid_json', 400)
  }
}
function pagination(url: URL, detail: boolean) {
  const pageKey = detail ? 'historyPage' : 'page',
    perPageKey = detail ? 'historyPerPage' : 'perPage'
  if (
    [...url.searchParams.keys()].some((key) => key !== pageKey && key !== perPageKey) ||
    url.searchParams.getAll(pageKey).length > 1 ||
    url.searchParams.getAll(perPageKey).length > 1
  )
    return null
  const page = url.searchParams.get(pageKey) ?? '1',
    perPage = url.searchParams.get(perPageKey) ?? (detail ? '5' : '25')
  if (
    !/^[1-9][0-9]*$/.test(page) ||
    !/^[1-9][0-9]*$/.test(perPage) ||
    Number(page) > 1_000_000 ||
    Number(perPage) > (detail ? 10 : 100)
  )
    return null
  return { page: Number(page), perPage: Number(perPage) }
}
export async function handleCmsDraftHttp(
  request: Request,
  env: CmsDraftHttpEnvironment,
  dependencies: { publication?: Omit<CmsPublicationDependencies, 'database'> } = {}
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCmsNamespace(url.pathname)) return null
  if (url.pathname === '/api/admin/content/calendar') {
    if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
    if (
      [...url.searchParams.keys()].some((key) => !['month', 'page', 'perPage'].includes(key)) ||
      ['month', 'page', 'perPage'].some((key) => url.searchParams.getAll(key).length > 1) ||
      ['page', 'perPage'].some((key) => url.searchParams.has(key) && !/^[1-9][0-9]*$/.test(url.searchParams.get(key)!))
    )
      return error('invalid_input', 400)
    const input = {
      ...(url.searchParams.has('month') ? { month: url.searchParams.get('month') } : {}),
      page: Number(url.searchParams.get('page') ?? '1'),
      perPage: Number(url.searchParams.get('perPage') ?? '25')
    }
    try {
      const origin = new URL(env.AUTH_ORIGIN)
      if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
        throw new Error('invalid_cms_origin')
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
      )
        return error('csrf_rejected', 403)
      if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
      const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
      if (!claims) return error('unauthenticated', 401)
      return json(
        await readCmsEditorialCalendar(
          { ...dependencies.publication, enabled: dependencies.publication?.enabled === true, database: env.DB },
          claims,
          input
        )
      )
    } catch (failure) {
      if (failure instanceof CmsPublicationError)
        return error(
          failure.code,
          failure.code === 'unauthenticated'
            ? 401
            : ['forbidden', 'email_unverified', 'mfa_required'].includes(failure.code)
              ? 403
              : failure.code === 'feature_unavailable'
                ? 501
                : failure.code === 'invalid_input'
                  ? 400
                  : 503
        )
      return error('service_unavailable', 503)
    }
  }
  const collection = url.pathname === '/api/admin/content/pages',
    match =
      /^\/api\/admin\/content\/pages\/([^/]+)(?:\/(rollback|publish|preview|schedule|publication|withdraw|cancel-schedule|revoke-preview))?$/.exec(
        url.pathname
      ),
    pageId = match?.[1],
    suffix = match?.[2]
  if ((!collection && !match) || (pageId !== undefined && !catalogPolicyUuidSchema.safeParse(pageId).success))
    return error('invalid_input', 400)
  const methods = collection
    ? ['GET', 'POST']
    : suffix === 'publication'
      ? ['GET']
      : suffix
        ? ['POST']
        : ['GET', 'PUT', 'DELETE']
  if (!methods.includes(request.method)) return error('method_not_allowed', 405, { Allow: methods.join(', ') })
  const read = request.method === 'GET',
    query = read
      ? suffix === 'publication'
        ? url.search === ''
          ? { page: 1, perPage: 5 }
          : null
        : pagination(url, !collection)
      : null
  if (read ? !query : url.searchParams.size > 0) return error('invalid_input', 400)
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_cms_origin')
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (!read && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      (read && request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    )
      return error('csrf_rejected', 403)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    if (suffix && suffix !== 'rollback') {
      const expectedAction = suffix.replaceAll('-', '_'),
        permission = ['preview', 'revoke_preview', 'publication'].includes(expectedAction)
          ? 'catalog.write'
          : 'catalog.publish'
      const live = await authorizeD1Session(env.DB, claims, permission, { requireMfa: true })
      if (!live.allowed) return error(live.code, live.code === 'unauthenticated' ? 401 : 403)
      if (!dependencies.publication?.enabled) return error('feature_unavailable', 501)
      const deps = { ...dependencies.publication, database: env.DB }
      if (suffix === 'publication') return json(await readCmsPublicationState(deps, claims, pageId!))
      const key = cmsIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
      if (!key.success) return error('invalid_idempotency_key', 400)
      const quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-cms-publication',
        limit: 60,
        windowSeconds: 3600
      })
      if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
      const input = cmsPublicationInputSchema.safeParse(await body(request))
      if (!input.success || input.data.action !== expectedAction) return error('invalid_input', 422)
      return json(await executeCmsPublicationCommand(deps, claims, pageId!, input.data, key.data))
    }
    const action: CmsAction = collection
        ? 'create_draft'
        : suffix === 'rollback'
          ? 'restore_draft'
          : request.method === 'DELETE'
            ? 'archive_draft'
            : 'update_draft',
      permission = read || (suffix && suffix !== 'rollback') ? CMS_READ_PERMISSION : CMS_ACTION_PERMISSIONS[action],
      auth = await authorizeD1Session(env.DB, claims, permission, { requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (read) {
      const data = collection
        ? await listD1CmsPages(env.DB, claims, query!)
        : await getD1CmsPage(env.DB, claims, pageId!, query!)
      if (dependencies.publication?.enabled) {
        const publish = await authorizeD1Session(env.DB, claims, 'catalog.publish', { requireMfa: true }),
          final = await authorizeD1Session(env.DB, claims, CMS_READ_PERMISSION, { requireMfa: true })
        if (!final.allowed) return error(final.code, final.code === 'unauthenticated' ? 401 : 403)
        data.capabilities = {
          ...data.capabilities,
          contentPublish: publish.allowed,
          contentSchedule: publish.allowed,
          contentPreview: cmsPreviewConfigured({ ...dependencies.publication, database: env.DB })
        }
      }
      return json(data)
    }
    const key = cmsIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_idempotency_key', 400)
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(env.DB, {
        identityId: claims.identityId,
        scope: 'admin-cms-drafts',
        limit: 60,
        windowSeconds: 3600
      })
    } catch {
      return error('abuse_control_unavailable', 503)
    }
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    return json(
      await executeD1CmsDraftCommand(
        env.DB,
        claims,
        action,
        collection ? {} : { pageId: pageId! },
        await body(request),
        { idempotencyKey: key.data }
      ),
      collection ? 201 : 200,
      headers
    )
  } catch (failure) {
    if (failure instanceof CmsPublicationError)
      return error(
        failure.code,
        failure.code === 'unauthenticated'
          ? 401
          : ['forbidden', 'email_unverified', 'mfa_required'].includes(failure.code)
            ? 403
            : failure.code === 'not_found'
              ? 404
              : ['feature_unavailable', 'preview_unavailable', 'media_unavailable'].includes(failure.code)
                ? 501
                : ['invalid_input', 'invalid_schedule'].includes(failure.code)
                  ? 422
                  : ['version_conflict', 'idempotency_conflict', 'media_blocked', 'draft_not_editable'].includes(
                        failure.code
                      )
                    ? 409
                    : 503
      )
    if (failure instanceof CmsHttpError) return error(failure.code, failure.status)
    if (failure instanceof CmsDraftError)
      return error(
        failure.code,
        failure.code === 'unauthenticated'
          ? 401
          : ['email_unverified', 'mfa_required', 'forbidden'].includes(failure.code)
            ? 403
            : failure.code === 'not_found'
              ? 404
              : failure.code === 'invalid_input'
                ? 422
                : 409
      )
    return error('service_unavailable', 503)
  }
}
