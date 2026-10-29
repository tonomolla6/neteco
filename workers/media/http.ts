import { authorizeAdministrativeRequest } from '../auth/authorize'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { MAX_MEDIA_UPLOAD_BYTES, quarantineMediaUpload } from '../catalog/media'
import { validateMediaUploadEnvelope } from '../../shared/media-envelope'
import { imageDimensions } from '../../shared/media-dimensions'
import { abuseLimitRule } from '../../server/utils/abuse-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'

export interface MediaHttpDependencies {
  database: D1Database
  bucket: Parameters<typeof quarantineMediaUpload>[1]
  edgeLimiter: RateLimit
  configuration: () => (SessionCookieConfiguration & { origin: string; rateLimitPepper: string }) | null
}

class InputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

async function boundedBody(request: Request) {
  const maximum = MAX_MEDIA_UPLOAD_BYTES + 64 * 1024
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new InputError(413, 'body_too_large')
  if (!request.body) throw new InputError(400, 'missing_body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximum) {
        await reader.cancel()
        throw new InputError(413, 'body_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Same multipart field names as the Nuxt admin form. No publication endpoint.
 * The origin is trusted deployment configuration, never Host/forwarded headers.
 */
export async function handleMediaUploadHttp(request: Request, deps: MediaHttpDependencies): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/admin/media' || request.method === 'GET') return null
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405)
  try {
    const configuration = deps.configuration()
    if (!configuration) return json({ error: { code: 'media_unavailable' } }, 503)
    const origin = new URL(configuration.origin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.origin)
      throw new Error('invalid_media_origin_configuration')
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, configuration.rateLimitPepper)
    if (edge === 'unavailable') return json({ error: { code: 'abuse_control_unavailable' } }, 503)
    if (edge === 'limited') return json({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '60' })
    const authorization = await authorizeAdministrativeRequest(request, deps.database, configuration, 'catalog.write')
    if (!authorization.allowed)
      return json({ error: { code: authorization.code } }, authorization.code === 'unauthenticated' ? 401 : 403)
    if (
      request.headers.get('origin') !== configuration.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      return json({ error: { code: 'csrf_rejected' } }, 403)
    }
    const policy = abuseLimitRule('POST', '/api/admin/media')
    if (!policy) throw new Error('missing_media_quota_policy')
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    try {
      quota = await consumeIdentityQuota(deps.database, { identityId: authorization.identityId, ...policy })
    } catch {
      throw new InputError(503, 'abuse_control_unavailable')
    }
    const quotaHeaders = { 'x-ratelimit-limit': String(policy.limit), 'x-ratelimit-remaining': String(quota.remaining) }
    if (!quota.allowed)
      return json({ error: { code: 'rate_limited' } }, 429, {
        ...quotaHeaders,
        'retry-after': String(quota.retryAfter)
      })
    const contentType = request.headers.get('content-type') ?? ''
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new InputError(415, 'multipart_required')
    const key = request.headers.get('idempotency-key') ?? crypto.randomUUID()
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new InputError(400, 'invalid_idempotency_key')
    const bytes = await boundedBody(request)
    let form: FormData
    try {
      form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
    } catch {
      throw new InputError(400, 'invalid_multipart')
    }
    const allowed = new Set(['file', 'ownerName', 'license', 'authorizedAt', 'altText', 'source'])
    for (const name of form.keys()) {
      if (!allowed.has(name) || form.getAll(name).length !== 1) throw new InputError(400, 'invalid_multipart_fields')
    }
    const file = form.get('file')
    if (!file || typeof file === 'string' || !file.name || !file.size) throw new InputError(400, 'missing_file')
    if (file.size > MAX_MEDIA_UPLOAD_BYTES) throw new InputError(413, 'body_too_large')
    function field(name: string, maximum: number, required = true) {
      const value = form.get(name)
      if (value === null && !required) return ''
      if (typeof value !== 'string' || !value.trim() || value.length > maximum)
        throw new InputError(400, 'invalid_media_metadata')
      return value.trim()
    }
    const owner = field('ownerName', 300)
    const license = field('license', 500)
    const authorizedAt = field('authorizedAt', 10)
    const day = Date.parse(`${authorizedAt}T00:00:00Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(authorizedAt) ||
      !Number.isFinite(day) ||
      new Date(day).toISOString().slice(0, 10) !== authorizedAt ||
      day > Date.now()
    ) {
      throw new InputError(400, 'invalid_authorization_date')
    }
    const alt = field('altText', 500)
    const source = field('source', 1000, false)
    const original = new Uint8Array(await file.arrayBuffer())
    try {
      const type = validateMediaUploadEnvelope({
        bytes: original,
        declaredType: file.type,
        maximumBytes: MAX_MEDIA_UPLOAD_BYTES
      })
      imageDimensions(original, type)
      if (type.startsWith('image/') && alt.length < 5) throw new Error('short_alt')
    } catch {
      throw new InputError(422, 'invalid_media_file')
    }
    const result = await quarantineMediaUpload(deps.database, deps.bucket, {
      actorId: authorization.identityId,
      idempotencyKey: key,
      bytes: original,
      declaredType: file.type,
      filename: file.name,
      alt,
      // This records a declaration, NOT verified evidence of a license. The
      // required date is retained without synthesizing an external source URL.
      rights: {
        owner,
        license,
        source: JSON.stringify({ kind: 'uploader_declaration', authorizedAt, reference: source || null })
      }
    })
    return json(
      { id: result.id, quarantineStatus: 'pending', rightsStatus: 'pending', canApprove: false },
      201,
      quotaHeaders
    )
  } catch (error) {
    if (error instanceof InputError) return json({ error: { code: error.code } }, error.status)
    if (error instanceof Error && error.message === 'media_idempotency_conflict')
      return json({ error: { code: 'idempotency_conflict' } }, 409)
    if (error instanceof Error && ['invalid_media_metadata', 'invalid_media_dimensions'].includes(error.message))
      return json({ error: { code: error.message } }, 422)
    return json({ error: { code: 'internal' } }, 500)
  }
}
