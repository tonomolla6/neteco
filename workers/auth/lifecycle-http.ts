import { canonicalAddress, checkAdministrativeEdgeLimit } from './edge-limit'
import { consumeAuthenticationQuota } from './anonymous-quota'
import { clearedSessionCookie, validateSessionCookieConfiguration } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { readD1UserSession } from './profile'
import {
  lifecycleEmailChangeSchema,
  lifecycleForgotSchema,
  lifecycleRegisterSchema,
  lifecycleResetSchema,
  lifecycleVerifySchema,
  registerD1Identity,
  requestD1EmailChange,
  requestD1PasswordReset,
  resetD1Password,
  verifyD1Email,
  validateIdentityLifecycleSecrets,
  type IdentityLifecycleSecrets
} from './lifecycle'

export interface IdentityLifecycleHttpDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  configuration: () => (SessionCookieConfiguration & IdentityLifecycleSecrets & { origin: string }) | null
  /** Internal deterministic clock only, never request controlled. Canonical UTC seconds. */
  now?: () => string
}
const routes = {
  '/api/auth/register': 'register',
  '/api/auth/forgot-password': 'forgot-password',
  '/api/auth/reset-password': 'reset-password',
  '/api/auth/verify-email': 'verify-email',
  '/api/account/email-change': 'account-email-change'
} as const
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}
function error(code: string, status: number, headers: Record<string, string> = {}) {
  return json({ error: { code } }, status, headers)
}
class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
/** Byte-bounded even for chunked bodies; no parsing/password work before this cap. */
async function readBody(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError(415, 'json_required')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) throw new BodyError(413, 'body_too_large')
  if (!request.body) throw new BodyError(400, 'invalid_body')
  const reader = request.body.getReader(),
    bytes = new Uint8Array(4096)
  let offset = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (offset + next.value.byteLength > bytes.length) {
        await reader.cancel()
        throw new BodyError(413, 'body_too_large')
      }
      bytes.set(next.value, offset)
      offset += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) as unknown
  } catch {
    throw new BodyError(400, 'invalid_body')
  }
}

export async function handleIdentityLifecycleHttp(
  request: Request,
  deps: IdentityLifecycleHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const scope = routes[url.pathname as keyof typeof routes]
  if (!scope) return null
  if (request.method !== 'POST') return error('method_not_allowed', 405, { allow: 'POST' })
  try {
    const configuration = deps.configuration()
    if (!configuration) return error('identity_lifecycle_unavailable', 503)
    validateSessionCookieConfiguration(configuration)
    validateIdentityLifecycleSecrets(configuration)
    const origin = new URL(configuration.origin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.origin)
      throw new Error('invalid_identity_lifecycle_origin')
    if (
      url.origin !== origin.origin ||
      request.headers.get('origin') !== origin.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const edge = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      configuration.tokenPepper,
      'authentication'
    )
    if (edge === 'unavailable') return error('abuse_control_unavailable', 503)
    if (edge === 'limited') return error('rate_limited', 429, { 'retry-after': '60' })
    const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
    if (!address) return error('abuse_control_unavailable', 503)
    const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const timestamp = Date.parse(now)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
      throw new Error('invalid_identity_lifecycle_instant')
    // Persisted IP accounting precedes body reads, including malformed/chunked requests.
    const quota = await consumeAuthenticationQuota(deps.database, {
      subject: address,
      kind: 'ip',
      scope,
      pepper: configuration.tokenPepper,
      now: Math.floor(timestamp / 1000)
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'retry-after': String(quota.retryAfter) })
    const body = await readBody(request)
    if (scope === 'register' || scope === 'forgot-password') {
      const parsed = (scope === 'register' ? lifecycleRegisterSchema : lifecycleForgotSchema).safeParse(body)
      if (!parsed.success) return error('invalid_body', 400)
      const emailQuota = await consumeAuthenticationQuota(deps.database, {
        subject: parsed.data.email,
        kind: 'email',
        scope,
        pepper: configuration.tokenPepper,
        now: Math.floor(timestamp / 1000)
      })
      if (!emailQuota.allowed) return error('rate_limited', 429, { 'retry-after': String(emailQuota.retryAfter) })
      if (scope === 'forgot-password') {
        await requestD1PasswordReset(deps.database, lifecycleForgotSchema.parse(body), configuration, now)
        return json(
          {
            ok: true,
            message: 'Si existe una cuenta con ese email, recibirás un enlace para restablecer la contraseña.'
          },
          202
        )
      }
      const registration = lifecycleRegisterSchema.parse(body)
      if (registration.newsletter && !configuration.newsletterSecrets) return error('newsletter_unavailable', 503)
      const result = await registerD1Identity(deps.database, registration, configuration, now)
      // Both outcomes intentionally have identical body/status and no cookie or
      // identity projection. A duplicate address must not enumerate accounts or
      // acquire the existing customer's profile. Scrypt runs for both outcomes.
      if (!result.ok && result.code !== 'email_unavailable') throw new Error('registration_not_accepted')
      return json(
        {
          ok: true,
          verificationRequired: true,
          message:
            'Si la dirección es elegible, recibirás un enlace para verificar el email. Después podrás iniciar sesión.'
        },
        202
      )
    }
    if (scope === 'reset-password') {
      const parsed = lifecycleResetSchema.safeParse(body)
      if (!parsed.success) return error('invalid_body', 400)
      const result = await resetD1Password(deps.database, parsed.data, configuration, now)
      return result.ok ? json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie }) : error(result.code, 400)
    }
    if (scope === 'verify-email') {
      const parsed = lifecycleVerifySchema.safeParse(body)
      if (!parsed.success) return error('invalid_body', 400)
      const result = await verifyD1Email(deps.database, parsed.data, configuration, now)
      if (!result.ok) return error(result.code, result.code === 'email_unavailable' ? 409 : 400)
      if (result.emailChanged)
        return json({ ok: true, emailChanged: true }, 200, { 'set-cookie': clearedSessionCookie })
      // A caller's existing signed live session may be projected; an anonymous
      // link visitor never gets a session cookie or a password/MFA bypass.
      const profile = await readD1UserSession(deps.database, request, configuration)
      return json({
        ok: true,
        ...('user' in profile && profile.user?.id === result.identityId ? { user: profile.user } : {})
      })
    }
    const parsed = lifecycleEmailChangeSchema.safeParse(body)
    if (!parsed.success) return error('invalid_body', 400)
    const result = await requestD1EmailChange(deps.database, request, configuration, parsed.data, now)
    if (!result.ok)
      return error(
        result.code,
        result.code === 'rate_limited'
          ? 429
          : result.code === 'mfa_required'
            ? 403
            : ['same_email', 'email_unavailable', 'conflict'].includes(result.code)
              ? 409
              : 401,
        result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}
      )
    return json({ ok: true, message: 'El enlace de confirmación está pendiente de envío al nuevo email.' }, 202)
  } catch (cause) {
    if (cause instanceof BodyError) return error(cause.code, cause.status)
    // D1/crypto/config failures are availability failures, never credentials or
    // invalid-token outcomes. Never serialize/log exception details or secrets.
    return error('identity_lifecycle_unavailable', 503)
  }
}
