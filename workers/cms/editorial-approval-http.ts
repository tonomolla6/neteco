import { z } from 'zod'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { cmsIdempotencyKeySchema } from '../../shared/cms-commands'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import type { CmsDraftHttpEnvironment } from './http'
import type { CmsPublicationDependencies } from './publication-gate'
import {
  createEditorialReview,
  assignReviewer,
  updateChecklistItem,
  addReviewComment,
  approveEditorialReview,
  rejectEditorialReview,
  withdrawEditorialReview,
  getEditorialReview,
  listEditorialReviews,
  EditorialApprovalError,
  type EditorialReviewStatus
} from './editorial-approval'

const MAX_BODY_BYTES = 65536

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

class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

async function parseBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new HttpError('body_too_large', 413)
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError('json_required', 415)
  }
  if (!request.body) throw new HttpError('missing_body', 400)
  const reader = request.body.getReader()
  const bytes = new Uint8Array(MAX_BODY_BYTES)
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw new HttpError('invalid_json', 400)
      if (chunk.value.byteLength > MAX_BODY_BYTES - length) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError('body_too_large', 413)
      }
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new HttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new HttpError('invalid_json', 400)
  }
}

export async function handleEditorialApprovalHttp(
  request: Request,
  env: CmsDraftHttpEnvironment,
  _dependencies: { publication?: Omit<CmsPublicationDependencies, 'database'> } = {}
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/admin/content/editorial-reviews')) return null

  // 1. Origin and CSRF checks
  try {
    const origin = new URL(env.AUTH_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000) {
      throw new Error('invalid_cms_origin')
    }
    const isRead = request.method === 'GET'
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (!isRead && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      (isRead && request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN)
    ) {
      return error('csrf_rejected', 403)
    }

    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)

    // 2. Session verification
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)

    // 3. Rate limiting for mutating endpoints
    if (!isRead) {
      let quota
      try {
        quota = await consumeIdentityQuota(env.DB, {
          identityId: claims.identityId,
          scope: 'admin-editorial-approval',
          limit: 120,
          windowSeconds: 3600
        })
      } catch {
        return error('abuse_control_unavailable', 503)
      }
      if (!quota.allowed) {
        return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
      }
    }

    // 4. Route: GET /api/admin/content/editorial-reviews/templates
    if (url.pathname === '/api/admin/content/editorial-reviews/templates') {
      if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
      const rows = await env.DB.prepare(
        'SELECT content_type, is_critical, title, items_json FROM editorial_checklist_templates ORDER BY content_type'
      ).all<{ content_type: string; is_critical: number; title: string; items_json: string }>()
      const templates = (rows.results ?? []).map((r) => ({
        contentType: r.content_type,
        isCritical: r.is_critical === 1,
        title: r.title,
        items: JSON.parse(r.items_json)
      }))
      return json({ templates })
    }

    // 5. Route: /api/admin/content/editorial-reviews
    if (url.pathname === '/api/admin/content/editorial-reviews') {
      if (request.method === 'GET') {
        const page = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1
        const perPage = url.searchParams.get('perPage') ? Number(url.searchParams.get('perPage')) : 25
        const status = url.searchParams.get('status') as EditorialReviewStatus | null
        const assignedTo = url.searchParams.get('assignedTo') as 'me' | string | null
        const pageId = url.searchParams.get('pageId') ?? undefined

        const list = await listEditorialReviews(env.DB, claims, {
          page,
          perPage,
          status: status ?? undefined,
          assignedTo: assignedTo ?? undefined,
          pageId
        })
        return json(list)
      }

      if (request.method === 'POST') {
        const key = cmsIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
        if (!key.success) return error('invalid_idempotency_key', 400)

        const rawBody = await parseBody(request)
        const schema = z
          .object({
            pageId: catalogPolicyUuidSchema,
            versionId: catalogPolicyUuidSchema,
            contentType: z.enum(['general', 'legal', 'chemical_safety', 'pricing']).optional(),
            isCritical: z.boolean().optional(),
            assignedReviewerId: catalogPolicyUuidSchema.nullable().optional(),
            note: z.string().max(2000).optional()
          })
          .strict()

        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)

        const result = await createEditorialReview(env.DB, claims, parsed.data, { idempotencyKey: key.data })
        return json(result, 201)
      }

      return error('method_not_allowed', 405, { Allow: 'GET, POST' })
    }

    // 6. Subroutes: /api/admin/content/editorial-reviews/:id/(assign|checklist|comments|approve|reject|withdraw)?
    const match =
      /^\/api\/admin\/content\/editorial-reviews\/([0-9a-f-]{36})(?:\/(assign|checklist|comments|approve|reject|withdraw))?$/.exec(
        url.pathname
      )
    if (!match) return error('not_found', 404)

    const reviewId = match[1]!
    const action = match[2]

    if (!action) {
      if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
      const detail = await getEditorialReview(env.DB, claims, reviewId)
      return json(detail)
    }

    if (request.method !== 'POST') return error('method_not_allowed', 405, { Allow: 'POST' })

    const key = cmsIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_idempotency_key', 400)

    const rawBody = await parseBody(request)

    switch (action) {
      case 'assign': {
        const schema = z
          .object({
            assignedReviewerId: catalogPolicyUuidSchema,
            expectedVersion: z.number().int().min(1)
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await assignReviewer(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }))
      }

      case 'checklist': {
        const schema = z
          .object({
            itemKey: z.string().min(1).max(80),
            completed: z.boolean(),
            expectedVersion: z.number().int().min(1)
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await updateChecklistItem(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }))
      }

      case 'comments': {
        const schema = z
          .object({
            comment: z.string().min(1).max(2000)
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await addReviewComment(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }), 201)
      }

      case 'approve': {
        const schema = z
          .object({
            expectedVersion: z.number().int().min(1),
            note: z.string().max(2000).optional()
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await approveEditorialReview(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }))
      }

      case 'reject': {
        const schema = z
          .object({
            expectedVersion: z.number().int().min(1),
            reason: z.string().min(3).max(500)
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await rejectEditorialReview(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }))
      }

      case 'withdraw': {
        const schema = z
          .object({
            expectedVersion: z.number().int().min(1),
            reason: z.string().min(3).max(500)
          })
          .strict()
        const parsed = schema.safeParse(rawBody)
        if (!parsed.success) return error('invalid_input', 422)
        return json(await withdrawEditorialReview(env.DB, claims, reviewId, parsed.data, { idempotencyKey: key.data }))
      }

      default:
        return error('not_found', 404)
    }
  } catch (err) {
    if (err instanceof EditorialApprovalError) {
      const status =
        err.code === 'unauthenticated'
          ? 401
          : [
                'forbidden',
                'email_unverified',
                'mfa_required',
                'mfa_expired',
                'author_cannot_approve',
                'author_cannot_publish'
              ].includes(err.code)
            ? 403
            : err.code === 'not_found'
              ? 404
              : [
                    'version_conflict',
                    'idempotency_conflict',
                    'invalid_transition',
                    'checklist_incomplete',
                    'review_not_approved'
                  ].includes(err.code)
                ? 409
                : 422
      return error(err.code, status)
    }
    if (err instanceof HttpError) {
      return error(err.code, err.status)
    }
    return error('service_unavailable', 503)
  }
}
