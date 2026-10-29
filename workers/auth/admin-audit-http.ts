import type { SessionCookieConfiguration } from './session-cookie'
import { verifySessionCookie } from './session-cookie'
import { consumeIdentityQuota } from './identity-quota'
import { deriveAdminAuditIpHash } from './admin-audit-network'
import { supportBody, supportJson } from '../support/http'
import { SupportError } from '../support/operations'
import { supportUuid } from '../../shared/support-operations'
import {
  adminAuditIdSchema,
  adminAuditHashSchema,
  adminAuditQuerySchema,
  adminAuditReviewInputSchema,
  adminAuditExportInputSchema,
  adminAuditReceiptSchema,
  adminAuditListSchema,
  adminAuditDetailSchema,
  adminAuditCommandSchema,
  ADMIN_AUDIT_EXPORT_FILENAME,
  ADMIN_AUDIT_EXPORT_CONTENT_TYPE,
  ADMIN_AUDIT_EXPORT_HEADERS,
  ADMIN_AUDIT_EXPORT_MAX_BYTES
} from '../../shared/admin-audit'
import {
  AdminAuditError,
  authorizeD1AdminAuditActor,
  readD1AdminAudit,
  readD1AdminAuditDetail,
  reviewD1AdminAudit,
  exportD1AdminAudit,
  readD1AdminAuditCommand,
  downloadD1AdminAuditExport
} from './admin-audit'

export interface AdminAuditHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}

export function ownsAdminAuditNamespace(path: string) {
  if (path.length > 4096) return false
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/audit(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      break
    }
  }
  return false
}

const statuses: Record<string, number> = {
  invalid_input: 422,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  export_too_large: 409,
  history_unconfirmed: 503,
  service_unavailable: 503,
  body_too_large: 413
}
const failure = (code: string) => supportJson({ error: { code } }, statuses[code] ?? 503)

function eventSegment(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const decoded = decodeURIComponent(raw)
    if (raw !== decoded && raw !== encodeURIComponent(decoded)) return null
    return adminAuditIdSchema.safeParse(decoded).success ? decoded : null
  } catch {
    return null
  }
}

/** Edge admission is invoked exactly once, before any cookie parsing or D1. */
export async function handleAdminAuditHttp(
  request: Request,
  deps: AdminAuditHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminAuditNamespace(url.pathname)) return null
  const base = '/api/admin/audit',
    list = url.pathname === base,
    exporting = url.pathname === `${base}/exports`,
    command = /^\/api\/admin\/audit\/commands\/([a-f0-9-]{36})$/.exec(url.pathname),
    download = /^\/api\/admin\/audit\/exports\/([a-f0-9-]{36})\/download$/.exec(url.pathname),
    review = /^\/api\/admin\/audit\/([^/]+)\/reviews$/.exec(url.pathname),
    detail = /^\/api\/admin\/audit\/([^/]+)$/.exec(url.pathname),
    eventId = eventSegment(review?.[1] ?? (!exporting ? detail?.[1] : undefined))
  if (
    (!list && !exporting && !command && !download && !eventId) ||
    (command && !supportUuid.safeParse(command[1]).success) ||
    (download && !supportUuid.safeParse(download[1]).success)
  )
    return failure('not_found')
  const method = exporting || review ? 'POST' : 'GET'
  if (request.method !== method) return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: method })
  try {
    if (
      !deps.sessionCookieConfiguration ||
      typeof deps.edgeGate !== 'function' ||
      typeof deps.rateLimitPepper !== 'string' ||
      deps.rateLimitPepper.length < 32 ||
      deps.rateLimitPepper.startsWith('local-only-') ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:'
    )
      return failure('service_unavailable')
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (method === 'POST'
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate(request)
    if (edge === 'denied') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const options = { now: deps.now }
    await authorizeD1AdminAuditActor(deps.database, claims, options)
    const allowed = list
      ? ['family', 'actorId', 'resourceId', 'from', 'to', 'limit', 'cursor']
      : command
        ? ['payloadHash']
        : []
    for (const key of url.searchParams.keys())
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure('invalid_input')
    if (list) {
      const query = adminAuditQuerySchema.safeParse(Object.fromEntries(url.searchParams))
      if (!query.success) return failure('invalid_input')
      return supportJson(adminAuditListSchema.parse(await readD1AdminAudit(deps.database, claims, query.data, options)))
    }
    if (command) {
      const hash = adminAuditHashSchema.safeParse(url.searchParams.get('payloadHash'))
      if (!hash.success) return failure('invalid_input')
      const result = adminAuditCommandSchema.parse(
        await readD1AdminAuditCommand(deps.database, claims, command[1]!, hash.data, options)
      )
      if (
        result.outcome === 'applied' &&
        (result.receipt.commandId !== command[1] || result.receipt.payloadHash !== hash.data)
      )
        return failure('history_unconfirmed')
      return supportJson(result)
    }
    if (download) {
      const result = await downloadD1AdminAuditExport(deps.database, claims, download[1]!, options)
      const receipt = adminAuditReceiptSchema.parse(result.receipt),
        bytes = new TextEncoder().encode(result.csv)
      if (
        receipt.action !== 'export' ||
        receipt.commandId !== download[1] ||
        bytes.byteLength !== receipt.bytes ||
        bytes.byteLength > ADMIN_AUDIT_EXPORT_MAX_BYTES
      )
        return failure('history_unconfirmed')
      // No await after core's final authority check: construct the private response synchronously.
      return new Response(bytes, {
        headers: {
          'Content-Type': ADMIN_AUDIT_EXPORT_CONTENT_TYPE,
          'Content-Disposition': `attachment; filename="${ADMIN_AUDIT_EXPORT_FILENAME}"`,
          'Cache-Control': 'private, no-store',
          Pragma: 'no-cache',
          Vary: 'Cookie',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Referrer-Policy': 'no-referrer',
          [ADMIN_AUDIT_EXPORT_HEADERS.source]: 'cloudflare',
          [ADMIN_AUDIT_EXPORT_HEADERS.rows]: String(receipt.rows),
          [ADMIN_AUDIT_EXPORT_HEADERS.bytes]: String(receipt.bytes),
          [ADMIN_AUDIT_EXPORT_HEADERS.digest]: receipt.digest
        }
      })
    }
    if (method === 'GET')
      return supportJson(
        adminAuditDetailSchema.parse(await readD1AdminAuditDetail(deps.database, claims, eventId!, options))
      )
    const raw = await supportBody(request),
      key = request.headers.get('idempotency-key') ?? ''
    if (!supportUuid.safeParse(key).success) return failure('invalid_input')
    const parsed = exporting ? adminAuditExportInputSchema.safeParse(raw) : adminAuditReviewInputSchema.safeParse(raw)
    if (!parsed.success) return failure('invalid_input')
    const ipHash = await deriveAdminAuditIpHash(request, deps.rateLimitPepper)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-audit-write',
      limit: 60,
      windowSeconds: 3600,
      now: deps.now ? Math.floor(Date.parse(deps.now) / 1000) : undefined
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    const commandOptions = { ...options, idempotencyKey: key, ipHash }
    const receipt = adminAuditReceiptSchema.parse(
      exporting
        ? await exportD1AdminAudit(deps.database, claims, parsed.data, commandOptions)
        : await reviewD1AdminAudit(deps.database, claims, eventId!, parsed.data, commandOptions)
    )
    if (
      receipt.commandId !== key ||
      receipt.action !== (exporting ? 'export' : 'review') ||
      (receipt.action === 'review' && receipt.eventId !== eventId)
    )
      return failure('history_unconfirmed')
    return supportJson(receipt, 201)
  } catch (error) {
    if (error instanceof AdminAuditError) return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
