import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { analyticsConsent } from '../../server/utils/analytics'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  MarketingModalError,
  evaluateD1MarketingModalEligibility,
  executeD1AdminMarketingModal,
  listD1AdminMarketingModals,
  readD1AdminMarketingModal,
  readD1AdminMarketingModalCommand,
  recordD1MarketingModalInteraction,
  updateD1MarketingModalPolicy
} from './marketing-modals'

export interface MarketingModalsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  /** Canonical https origin of the storefront; every write must come from it. */
  origin: string
  /** Secret used to keyed-hash the anonymous visitor id (never stored raw). */
  rateLimitPepper: string
  /** Server/test clock only, never HTTP input. */
  now?: string
}

const MAX_BODY_BYTES = 65536
const ADMIN_PREFIX = '/api/admin/marketing-modals'
const PUBLIC_PREFIX = '/api/marketing/modals'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } })
}

const failure = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)

class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}

/** Decodes percent-encoding up to a fixed depth so that encoded namespaces are still owned. */
function canonicalPath(pathname: string): string | null {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return path
      path = decoded
    } catch {
      return null
    }
  }
  return null
}

export function ownsMarketingModalsNamespace(pathname: string): boolean {
  const path = canonicalPath(pathname)
  if (path === null) return false
  return /^\/api\/(?:admin\/marketing-modals|marketing\/modals)(?:[/\\%]|$)/i.test(path)
}

/** Admin routes need the administrative edge limit and the AUTH_ENABLED gate; public ones do not. */
export function isAdminMarketingModalsPath(pathname: string): boolean {
  const path = canonicalPath(pathname)
  return path !== null && /^\/api\/admin\/marketing-modals(?:[/\\%]|$)/i.test(path)
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new BoundaryError('body_too_large', 413)
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    throw new BoundaryError('json_required', 415)
  }
  if (!request.body) throw new BoundaryError('invalid_input', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new BoundaryError('body_too_large', 413)
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new BoundaryError('invalid_input', 400)
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('invalid_input', 400)
  return value as Record<string, unknown>
}

/** Exact-once cookie lookup; duplicated cookies are ambiguous and rejected. */
function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined
  if (header.length > 8192) throw new BoundaryError('invalid_input', 400)
  let result: string | undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== name) continue
    if (result !== undefined) throw new BoundaryError('invalid_input', 400)
    result = part.slice(at + 1).trim()
  }
  return result
}

/** Server-side consent truth: the analytics and marketing flags come only from the consent cookie. */
function consentFlags(request: Request): { analytics: boolean; marketing: boolean } {
  const raw = cookieValue(request, 'neteco-consent-v1')
  if (!raw) return { analytics: false, marketing: false }
  const analytics = analyticsConsent(raw)
  let marketing = false
  let decoded = raw
  for (let index = 0; index < 2 && !marketing; index++) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      break
    }
    try {
      const parsed = JSON.parse(decoded.startsWith('j:') ? decoded.slice(2) : decoded) as {
        version?: unknown
        marketing?: unknown
      }
      marketing = parsed.version === 'v1' && parsed.marketing === true
    } catch {
      // Unparseable cookies never grant consent.
    }
  }
  return { analytics, marketing }
}

function anonymousVisitorToken(request: Request): string | null {
  const value = cookieValue(request, 'neteco-analytics-id')
  return value && value.length >= 8 && value.length <= 200 ? value : null
}

function statusForCode(code: string): number {
  switch (code) {
    case 'unauthenticated':
      return 401
    case 'email_unverified':
    case 'mfa_required':
    case 'forbidden':
      return 403
    case 'invalid_input':
      return 400
    case 'not_found':
      return 404
    case 'version_conflict':
    case 'idempotency_conflict':
    case 'code_immutable':
    case 'code_conflict':
    case 'modal_retired':
      return 409
    case 'body_too_large':
      return 413
    case 'json_required':
      return 415
    case 'rate_limited':
      return 429
    default:
      return 503
  }
}

function errorResponse(failureValue: unknown): Response {
  if (failureValue instanceof BoundaryError) return failure(failureValue.code, failureValue.status)
  if (failureValue instanceof MarketingModalError) {
    return failure(failureValue.code, statusForCode(failureValue.code))
  }
  return failure('service_unavailable', 503)
}

function query(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new BoundaryError('invalid_input', 400)
  }
}

function positive(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue
  if (!/^[1-9]\d{0,6}$/.test(value)) throw new BoundaryError('invalid_input', 400)
  return Number(value)
}

export async function handleMarketingModalsHttp(
  request: Request,
  deps: MarketingModalsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsMarketingModalsNamespace(url.pathname)) return null
  const path = canonicalPath(url.pathname)
  if (path === null) return failure('not_found', 404)

  const adminCollection = path === ADMIN_PREFIX
  const adminPolicy = path === `${ADMIN_PREFIX}/policy`
  const adminCommand = /^\/api\/admin\/marketing-modals\/commands\/([0-9a-f-]{36})$/.exec(path)
  const adminDetail = /^\/api\/admin\/marketing-modals\/([0-9a-f-]{36})$/.exec(path)
  const publicEligibility = path === `${PUBLIC_PREFIX}/eligibility`
  const publicEvents = path === `${PUBLIC_PREFIX}/events`
  const id = adminCommand?.[1] ?? adminDetail?.[1]

  if (
    (!adminCollection && !adminPolicy && !adminCommand && !adminDetail && !publicEligibility && !publicEvents) ||
    (id && !catalogPolicyUuidSchema.safeParse(id).success)
  ) {
    return failure('not_found', 404)
  }

  const allow = adminCollection ? 'GET, POST' : adminPolicy || publicEligibility || publicEvents ? 'POST' : 'GET'
  if (!allow.split(', ').includes(request.method)) return failure('method_not_allowed', 405, { Allow: allow })

  try {
    if (new URL(deps.origin).origin !== deps.origin || new URL(deps.origin).protocol !== 'https:') {
      return failure('service_unavailable', 503)
    }
    const write = request.method !== 'GET'
    const requestOrigin = request.headers.get('origin')
    if (
      url.origin !== deps.origin ||
      (write ? requestOrigin !== deps.origin : requestOrigin !== null && requestOrigin !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      return failure('csrf_rejected', 403)
    }

    const options = deps.now ? { now: deps.now } : {}

    if (publicEligibility || publicEvents) {
      const raw = plainObject(await readJsonBody(request))
      const consent = consentFlags(request)
      const visitorToken = consent.analytics ? anonymousVisitorToken(request) : null
      if (publicEligibility) {
        let claims: VerifiedSessionClaims | null = null
        try {
          claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
        } catch {
          claims = null
        }
        const result = await evaluateD1MarketingModalEligibility(
          deps.database,
          { ...raw, analyticsConsent: consent.analytics, marketingConsent: consent.marketing },
          {
            ...options,
            claims,
            visitorToken,
            hmacPepper: deps.rateLimitPepper
          }
        )
        return json(result)
      }
      const receipt = await recordD1MarketingModalInteraction(deps.database, raw, {
        ...options,
        visitorToken,
        hmacPepper: deps.rateLimitPepper,
        analyticsConsentCookie: consent.analytics
      })
      return json(receipt)
    }

    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated', 401)

    if (request.method === 'GET') {
      if (adminCommand) {
        query(url, [])
        return json(
          await readD1AdminMarketingModalCommand(
            deps.database,
            claims,
            id!,
            request.headers.get('X-Neteco-Command-Payload-Hash') ?? '',
            options
          )
        )
      }
      if (adminDetail) {
        query(url, ['historyPage'])
        return json(
          await readD1AdminMarketingModal(
            deps.database,
            claims,
            id!,
            { historyPage: positive(url.searchParams.get('historyPage'), 1) },
            options
          )
        )
      }
      query(url, ['q', 'status', 'page', 'perPage'])
      return json(
        await listD1AdminMarketingModals(
          deps.database,
          claims,
          {
            q: url.searchParams.get('q') ?? '',
            status: url.searchParams.get('status') ?? 'all',
            page: positive(url.searchParams.get('page'), 1),
            perPage: positive(url.searchParams.get('perPage'), 25)
          },
          options
        )
      )
    }

    query(url, [])
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-marketing-modal-commands',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed) return failure('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })

    const raw = await readJsonBody(request)
    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (adminPolicy) {
      return json(await updateD1MarketingModalPolicy(deps.database, claims, raw, { ...options, idempotencyKey }), 201)
    }
    return json(await executeD1AdminMarketingModal(deps.database, claims, raw, { ...options, idempotencyKey }), 201)
  } catch (failureValue) {
    return errorResponse(failureValue)
  }
}
