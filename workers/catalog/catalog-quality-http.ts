import { z } from 'zod'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { verifySessionCookie } from '../auth/session-cookie'
import { ADMIN_CATALOG_STATUSES, parseAdminCatalogLegacyId, type AdminCatalogStatus } from './admin-catalog'
import type { AdminCatalogHttpDependencies } from './admin-catalog-http'
import {
  CatalogQualityError,
  getD1CatalogProductQuality,
  getD1CatalogQualityReviewCommand,
  listD1CatalogQualityQueue,
  recordD1CatalogQualityReview,
  type CatalogQualityQueueQueryInput
} from './catalog-quality'

const MAX_REVIEW_BODY_BYTES = 16 * 1024

const QUEUE_PATH_REGEX = /^\/api\/admin\/(?:catalog\/)?products\/quality-queue$/
const REVIEW_PATH_REGEX = /^\/api\/admin\/(?:catalog\/)?products\/([^/]+)\/quality-review$/
const COMMAND_PATH_REGEX = /^\/api\/admin\/(?:catalog\/)?products\/([^/]+)\/quality-review\/commands\/([^/]+)$/

export function ownsCatalogQualityNamespace(pathname: string): boolean {
  return (
    pathname === '/api/admin/catalog/quality-queue' ||
    QUEUE_PATH_REGEX.test(pathname) ||
    REVIEW_PATH_REGEX.test(pathname) ||
    COMMAND_PATH_REGEX.test(pathname)
  )
}

function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, {
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

function errorResponse(code: string, status: number, extra: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code } }, status, extra)
}

class QualityHttpInputError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

async function readBoundedJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REVIEW_BODY_BYTES)) {
    throw new QualityHttpInputError('body_too_large', 413)
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    throw new QualityHttpInputError('json_required', 415)
  }
  if (!request.body) throw new QualityHttpInputError('missing_body', 400)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_REVIEW_BODY_BYTES) {
        await reader.cancel()
        throw new QualityHttpInputError('body_too_large', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (!length) throw new QualityHttpInputError('missing_body', 400)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new QualityHttpInputError('invalid_json', 400)
  }
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

function parseQualityQueueSearchParams(params: URLSearchParams): CatalogQualityQueueQueryInput | null {
  const allowed = new Set(['page', 'perPage', 'cursor', 'reason', 'category', 'status', 'q'])
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return null
  }

  const query: CatalogQualityQueueQueryInput = {}

  const pageRaw = params.get('page')
  if (pageRaw !== null) {
    if (!/^[1-9]\d{0,5}$/.test(pageRaw)) return null
    query.page = Number(pageRaw)
  }

  const perPageRaw = params.get('perPage')
  if (perPageRaw !== null) {
    if (!/^[1-9]\d{0,2}$/.test(perPageRaw)) return null
    const perPage = Number(perPageRaw)
    if (perPage > 100) return null
    query.perPage = perPage
  }

  const cursor = params.get('cursor')
  if (cursor !== null) {
    if (cursor.length < 3 || cursor.length > 200 || hasControlCharacters(cursor)) {
      return null
    }
    query.cursor = cursor
  }

  const reason = params.get('reason')
  if (reason !== null) {
    if (!/^[a-z0-9._-]{2,80}$/.test(reason)) return null
    query.reason = reason
  }

  const category = params.get('category')
  if (category !== null) {
    const trimmed = category.trim()
    if (!trimmed || trimmed.length > 120 || hasControlCharacters(trimmed)) return null
    const numericId = parseAdminCatalogLegacyId(trimmed)
    query.category = numericId !== null ? numericId : trimmed
  }

  const status = params.get('status')
  if (status !== null) {
    if (!(ADMIN_CATALOG_STATUSES as readonly string[]).includes(status)) return null
    query.status = status as AdminCatalogStatus
  }

  const q = params.get('q')
  if (q !== null) {
    if (q.length > 120 || hasControlCharacters(q)) return null
    query.q = q.trim()
  }

  return query
}

const reviewBodySchema = z
  .object({
    expectedCatalogVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedReviewVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    note: z.string().max(500).nullable().optional()
  })
  .strict()

export async function handleCatalogQualityHttp(
  request: Request,
  deps: AdminCatalogHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCatalogQualityNamespace(url.pathname)) return null

  const isQueue = url.pathname === '/api/admin/catalog/quality-queue' || QUEUE_PATH_REGEX.test(url.pathname)
  const reviewMatch = REVIEW_PATH_REGEX.exec(url.pathname)
  const commandMatch = COMMAND_PATH_REGEX.exec(url.pathname)

  const isMutation = reviewMatch !== null && request.method === 'POST'

  if (isQueue && request.method !== 'GET') {
    return errorResponse('method_not_allowed', 405, { Allow: 'GET' })
  }
  if (commandMatch && request.method !== 'GET') {
    return errorResponse('method_not_allowed', 405, { Allow: 'GET' })
  }
  if (reviewMatch && request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse('method_not_allowed', 405, { Allow: 'GET, POST' })
  }

  try {
    const trustedOrigin = new URL(deps.origin)
    if (trustedOrigin.protocol !== 'https:' || trustedOrigin.origin !== deps.origin || deps.origin.length > 2000) {
      throw new Error('invalid_admin_catalog_origin')
    }

    if (
      (isMutation
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      return errorResponse('csrf_rejected', 403)
    }

    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return errorResponse('unauthenticated', 401)

    if (isQueue) {
      const parsedQuery = parseQualityQueueSearchParams(url.searchParams)
      if (!parsedQuery) return errorResponse('invalid_input', 400)
      const data = await listD1CatalogQualityQueue(deps.database, claims, parsedQuery, {
        now: deps.now
      })
      return jsonResponse(data, 200)
    }

    if (commandMatch) {
      if (url.searchParams.size > 0) return errorResponse('invalid_input', 400)
      const productId = parseAdminCatalogLegacyId(commandMatch[1]!)
      const rawCommandId = commandMatch[2]!
      let commandId: string
      try {
        commandId = decodeURIComponent(rawCommandId)
      } catch {
        return errorResponse('invalid_input', 400)
      }
      if (productId === null || !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)) {
        return errorResponse('invalid_input', 400)
      }
      const result = await getD1CatalogQualityReviewCommand(deps.database, claims, productId, commandId, {
        now: deps.now
      })
      if (!result) return errorResponse('not_found', 404)
      return jsonResponse(result, 200)
    }

    if (reviewMatch) {
      if (url.searchParams.size > 0) return errorResponse('invalid_input', 400)
      const productId = parseAdminCatalogLegacyId(reviewMatch[1]!)
      if (productId === null) return errorResponse('invalid_input', 400)

      if (request.method === 'GET') {
        const item = await getD1CatalogProductQuality(deps.database, claims, productId, {
          now: deps.now
        })
        if (!item) return errorResponse('not_found', 404)
        return jsonResponse(item, 200)
      }

      const idempotencyKey = request.headers.get('idempotency-key')
      if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        return errorResponse('invalid_idempotency_key', 400)
      }

      let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
      try {
        quota = await consumeIdentityQuota(deps.database, {
          identityId: claims.identityId,
          scope: 'admin-catalog-quality-review',
          limit: 60,
          windowSeconds: 3600
        })
      } catch {
        return errorResponse('abuse_control_unavailable', 503)
      }

      const quotaHeaders = {
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': String(quota.remaining)
      }
      if (!quota.allowed) {
        return errorResponse('rate_limited', 429, {
          ...quotaHeaders,
          'Retry-After': String(quota.retryAfter)
        })
      }

      const rawBody = await readBoundedJsonBody(request)
      const parsedBody = reviewBodySchema.safeParse(rawBody)
      if (!parsedBody.success) {
        return errorResponse('invalid_input', 422, quotaHeaders)
      }

      const mutationResult = await recordD1CatalogQualityReview(deps.database, claims, {
        commandId: idempotencyKey,
        productId,
        expectedCatalogVersion: parsedBody.data.expectedCatalogVersion,
        expectedReviewVersion: parsedBody.data.expectedReviewVersion ?? 0,
        note: parsedBody.data.note ?? null,
        now: deps.now
      })
      return jsonResponse(mutationResult, 200, quotaHeaders)
    }

    return errorResponse('not_found', 404)
  } catch (failure) {
    if (failure instanceof QualityHttpInputError) {
      return errorResponse(failure.code, failure.status)
    }
    if (failure instanceof CatalogQualityError) {
      return errorResponse(failure.code, failure.status)
    }
    return errorResponse('service_unavailable', 503)
  }
}
