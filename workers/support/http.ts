import {
  supportPolicySchema,
  supportKey,
  supportRef,
  supportUuid,
  supportCategory,
  supportState
} from '../../shared/support-operations'
import type { SupportPolicy, SupportChallengeConfiguration } from '../../shared/support-operations'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { SupportError, supportClock, supportActor, type SupportActor, type SupportPage } from './operations'
import {
  uploadSupportAttachment,
  downloadSupportAttachment,
  type SupportPrivateStorage,
  type SupportScanReceiptVerifier
} from './attachments'
export interface SupportHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  policy?: SupportPolicy | null
  storage?: SupportPrivateStorage
  contactPepper?: string
  edgeGate?: (
    request: Request,
    area: 'contact' | 'admin' | 'customer' | 'scanner'
  ) => Promise<'allowed' | 'limited' | 'unavailable'>
  challengeVerifier?: (input: { token: string; request: Request }) => Promise<boolean>
  challengeConfiguration?: SupportChallengeConfiguration
  scanReceiptVerifier?: SupportScanReceiptVerifier
}
export function supportJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
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
export function supportHttpError(code: string, status?: number) {
  const actual =
    status ??
    (code === 'unauthenticated'
      ? 401
      : [
            'forbidden',
            'email_unverified',
            'mfa_required',
            'guest_verification_required',
            'invalid_scan_signature'
          ].includes(code)
        ? 403
        : code === 'not_found'
          ? 404
          : code === 'body_too_large'
            ? 413
            : ['invalid_input', 'invalid_file', 'invalid_scan_receipt'].includes(code)
              ? 422
              : code === 'challenge_required'
                ? 403
                : [
                      'version_conflict',
                      'idempotency_conflict',
                      'invalid_transition',
                      'owner_unavailable',
                      'retention_expired',
                      'attachment_unavailable',
                      'contact_context_required'
                    ].includes(code)
                  ? 409
                  : 503)
  return supportJson({ error: { code } }, actual)
}
export function supportFailure(error: unknown) {
  return error instanceof SupportError ? supportHttpError(error.code) : supportHttpError('service_unavailable', 503)
}
export function supportPolicy(deps: SupportHttpDependencies) {
  return deps.policy == null ? null : supportPolicySchema.parse(deps.policy)
}
export function ownsSupportNamespace(pathname: string, prefix: string) {
  let path = pathname
  for (let round = 0; round < 4; round++) {
    if (
      path === prefix ||
      path.startsWith(prefix + '/') ||
      path.startsWith(prefix + '\\') ||
      path.startsWith(prefix + '%')
    )
      return true
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
export async function supportBoundary(
  request: Request,
  deps: SupportHttpDependencies,
  area: 'contact' | 'admin' | 'customer' | 'scanner'
) {
  const origin = new URL(deps.origin)
  if (origin.protocol !== 'https:' || origin.origin !== deps.origin) throw new SupportError('service_unavailable')
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.method === 'GET'
      ? request.headers.has('origin') && request.headers.get('origin') !== deps.origin
      : request.headers.get('origin') !== deps.origin && area !== 'scanner')
  )
    throw new SupportError('forbidden')
  const edge = await deps.edgeGate?.(request, area)
  if (edge === 'limited') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
  if (edge !== 'allowed') return supportHttpError('abuse_control_unavailable', 503)
  return null
}
export async function supportHttpActor(
  request: Request,
  deps: SupportHttpDependencies,
  kind: 'admin' | 'customer'
): Promise<SupportActor> {
  if (!deps.sessionCookieConfiguration) throw new SupportError('service_unavailable')
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims)
    throw new SupportError(
      kind === 'customer' && /(?:^|;)\s*neteco-order-access-v2=/.test(request.headers.get('cookie') ?? '')
        ? 'guest_verification_required'
        : 'unauthenticated'
    )
  return supportActor(deps.database, claims, kind, supportClock())
}
export function supportRequestKey(request: Request) {
  const result = supportKey.safeParse(request.headers.get('idempotency-key'))
  if (!result.success) throw new SupportError('invalid_input')
  return result.data
}
export async function supportBytes(request: Request, maximum: number) {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum))
    throw new SupportError('body_too_large')
  if (!request.body) throw new SupportError('invalid_input')
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new SupportError('body_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export async function supportRawBody(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new SupportError('invalid_input')
  const bytes = await supportBytes(request, 16384)
  try {
    const rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { body: JSON.parse(rawBody) as unknown, rawBody }
  } catch {
    throw new SupportError('invalid_input')
  }
}
export async function supportBody(request: Request) {
  return (await supportRawBody(request)).body
}
export function supportPagination(url: URL, admin = false, list = false): SupportPage {
  const allowed = ['page', 'perPage', ...(admin && list ? ['q', 'state', 'category', 'owner'] : [])]
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new SupportError('invalid_input')
  const page = url.searchParams.get('page') ?? '1',
    perPage = url.searchParams.get('perPage') ?? '25'
  if (
    !/^[1-9][0-9]{0,6}$/.test(page) ||
    Number(page) > 1000000 ||
    !/^[1-9][0-9]?$/.test(perPage) ||
    Number(perPage) > 50
  )
    throw new SupportError('invalid_input')
  const q = url.searchParams.get('q'),
    state = url.searchParams.get('state'),
    category = url.searchParams.get('category'),
    owner = url.searchParams.get('owner')
  if (
    (q !== null && q.length > 100) ||
    (state !== null && !supportState.safeParse(state).success) ||
    (category !== null && !supportCategory.safeParse(category).success) ||
    (owner !== null && !supportUuid.safeParse(owner).success)
  )
    throw new SupportError('invalid_input')
  return {
    page: Number(page),
    perPage: Number(perPage),
    ...(q === null ? {} : { q }),
    ...(state === null ? {} : { state }),
    ...(category === null ? {} : { category }),
    ...(owner === null ? {} : { owner })
  }
}
export async function supportMutationQuota(
  deps: SupportHttpDependencies,
  actor: SupportActor,
  kind: 'admin' | 'customer'
) {
  if (!actor.claims) throw new SupportError('unauthenticated')
  const quota = await consumeIdentityQuota(deps.database, {
    identityId: actor.claims.identityId,
    scope: kind + '-support',
    limit: kind === 'admin' ? 60 : 20,
    windowSeconds: 3600
  })
  return quota.allowed
    ? null
    : supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
}
export async function supportAttachmentHttp(
  request: Request,
  deps: SupportHttpDependencies,
  actor: SupportActor,
  ref: string,
  id?: string
) {
  if (!supportRef.safeParse(ref).success) throw new SupportError('not_found')
  if (!deps.storage) throw new SupportError('attachments_unavailable')
  if (id) {
    if (request.method !== 'GET') return supportHttpError('method_not_allowed', 405)
    return downloadSupportAttachment(deps.database, deps.storage, actor, ref, id)
  }
  if (request.method !== 'POST') return supportHttpError('method_not_allowed', 405)
  const key = supportRequestKey(request),
    quota = await supportMutationQuota(deps, actor, actor.kind === 'admin' ? 'admin' : 'customer')
  if (quota) return quota
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new SupportError('invalid_input')
  const bytes = await supportBytes(request, 10485760 + 65536)
  let form: FormData
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw new SupportError('invalid_input')
  }
  for (const name of form.keys())
    if (!['file', 'expectedVersion', 'visibility'].includes(name) || form.getAll(name).length !== 1)
      throw new SupportError('invalid_input')
  const file = form.get('file'),
    version = form.get('expectedVersion'),
    visibility = form.get('visibility') ?? 'public'
  if (
    !file ||
    typeof file === 'string' ||
    typeof version !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(version) ||
    !['public', 'internal'].includes(String(visibility)) ||
    file.size > 10485760
  )
    throw new SupportError('invalid_input')
  const receipt = await uploadSupportAttachment(
    deps.database,
    deps.storage,
    actor,
    ref,
    {
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType: file.type,
      filename: file.name,
      expectedVersion: Number(version),
      visibility: visibility === 'internal' ? 'internal' : 'public'
    },
    { idempotencyKey: key }
  )
  return supportJson(receipt, 201)
}
