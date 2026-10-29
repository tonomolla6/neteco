import { authorizeD1Session } from '../catalog/authorization'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import {
  MediaGovernanceError,
  createMediaPublication,
  decideMediaRights,
  ingestMediaScanReceipt,
  listAdministrativeMedia,
  withdrawMediaPublication
} from './governance'

export interface MediaGovernanceHttpDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  configuration: () => (SessionCookieConfiguration & { origin: string; rateLimitPepper: string }) | null
  /** Separate MEDIA_SCAN_SECRET, never the browser cookie/encryption secret.
   * Absent scanner integration remains fail-closed, without synthetic receipts.
   */
  scanSecret: () => string | null
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      ...headers
    }
  })
}

async function boundedBody(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096))
    throw new HttpError(413, 'body_too_large')
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new HttpError(415, 'json_required')
  if (!request.body) throw new HttpError(400, 'missing_body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 4096) {
        await reader.cancel()
        throw new HttpError(413, 'body_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (!length) throw new HttpError(400, 'missing_body')
  return bytes
}

function parseBody(bytes: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

function idempotencyKey(request: Request) {
  const key = request.headers.get('idempotency-key')
  if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HttpError(400, 'invalid_idempotency_key')
  return key
}

function expectedVersion(request: Request, required = false) {
  const value = request.headers.get('if-match')
  if (value === null && !required) return undefined
  if (value === null) throw new HttpError(428, 'if_match_required')
  const unquoted = value.replace(/^"(\d+)"$/, '$1')
  if (!/^\d{1,16}$/.test(unquoted) || !Number.isSafeInteger(Number(unquoted)))
    throw new HttpError(400, 'invalid_if_match')
  return Number(unquoted)
}

function governanceStatus(error: MediaGovernanceError) {
  switch (error.code) {
    case 'unauthenticated':
      return 401
    case 'forbidden':
    case 'mfa_required':
    case 'email_unverified':
    case 'invalid_scan_signature':
      return 403
    case 'not_found':
      return 404
    case 'scan_unavailable':
      return 503
    case 'invalid_input':
    case 'invalid_scan_receipt':
      return 422
    default:
      return 409
  }
}

/** Exact routes only. Upload POST remains the separate private upload handler.
 * Decisions, associations and withdrawals require origin, edge + identity
 * quotas and a fresh catalog.publish/MFA check inside their atomic D1 batch.
 */
export async function handleMediaGovernanceHttp(
  request: Request,
  deps: MediaGovernanceHttpDependencies
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const scan = path === '/api/media/scan-receipts'
  const list = path === '/api/admin/media'
  const rights = /^\/api\/admin\/media\/([0-9a-f-]{36})$/i.exec(path)
  const publication = /^\/api\/admin\/media\/([0-9a-f-]{36})\/publications$/i.exec(path)
  const withdrawal = /^\/api\/admin\/media\/publications\/([0-9a-f-]{36})$/i.exec(path)
  if (!scan && !list && !rights && !publication && !withdrawal) return null
  if (list && request.method === 'POST') return null
  const method = scan || publication ? 'POST' : list ? 'GET' : withdrawal ? 'DELETE' : 'PUT'
  if (request.method !== method) return json({ error: { code: 'method_not_allowed' } }, 405, { allow: method })
  try {
    const configuration = deps.configuration()
    if (!configuration) throw new HttpError(503, 'media_unavailable')
    const origin = new URL(configuration.origin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.origin)
      throw new HttpError(503, 'media_unavailable')
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, configuration.rateLimitPepper)
    if (edge === 'unavailable') throw new HttpError(503, 'abuse_control_unavailable')
    if (edge === 'limited') return json({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '60' })
    if (scan) {
      const secret = deps.scanSecret()
      if (!secret || secret === configuration.password || secret === configuration.rateLimitPepper)
        throw new MediaGovernanceError('scan_unavailable')
      const bytes = await boundedBody(request)
      const result = await ingestMediaScanReceipt(
        deps.database,
        bytes,
        request.headers.get('x-media-scan-signature') ?? '',
        secret
      )
      return json(result, result.replayed ? 200 : 201)
    }
    const claims = await verifySessionCookie(request, configuration)
    if (!claims) throw new HttpError(401, 'unauthenticated')
    const permission = list ? 'catalog.write' : 'catalog.publish'
    const authorization = await authorizeD1Session(deps.database, claims, permission, { requireMfa: true })
    if (!authorization.allowed)
      throw new HttpError(authorization.code === 'unauthenticated' ? 401 : 403, authorization.code)
    const suppliedOrigin = request.headers.get('origin')
    if (
      (list
        ? suppliedOrigin !== null && suppliedOrigin !== configuration.origin
        : suppliedOrigin !== configuration.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new HttpError(403, 'csrf_rejected')
    let quota: Awaited<ReturnType<typeof consumeIdentityQuota>>
    const policy = list
      ? { scope: 'admin-media-list', limit: 120, windowSeconds: 60 }
      : { scope: 'admin-media-governance', limit: 40, windowSeconds: 3600 }
    try {
      quota = await consumeIdentityQuota(deps.database, { identityId: claims.identityId, ...policy })
    } catch {
      throw new HttpError(503, 'abuse_control_unavailable')
    }
    const quotaHeaders = { 'x-ratelimit-limit': String(policy.limit), 'x-ratelimit-remaining': String(quota.remaining) }
    if (!quota.allowed)
      return json({ error: { code: 'rate_limited' } }, 429, {
        ...quotaHeaders,
        'retry-after': String(quota.retryAfter)
      })
    if (list) return json(await listAdministrativeMedia(deps.database, claims), 200, quotaHeaders)
    const key = idempotencyKey(request)
    const version = expectedVersion(request, Boolean(withdrawal))
    const body = parseBody(await boundedBody(request))
    if (rights)
      return json(
        await decideMediaRights(deps.database, claims, rights[1]!, body, {
          idempotencyKey: key,
          expectedVersion: version
        }),
        200,
        quotaHeaders
      )
    if (publication) {
      const result = await createMediaPublication(deps.database, claims, publication[1]!, body, { idempotencyKey: key })
      return json(result, result.replayed ? 200 : 201, quotaHeaders)
    }
    return json(
      await withdrawMediaPublication(deps.database, claims, withdrawal![1]!, body, {
        idempotencyKey: key,
        expectedVersion: version
      }),
      200,
      quotaHeaders
    )
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code } }, error.status)
    if (error instanceof MediaGovernanceError) return json({ error: { code: error.code } }, governanceStatus(error))
    return json({ error: { code: 'internal' } }, 500)
  }
}
