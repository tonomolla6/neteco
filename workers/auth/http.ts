import { z } from 'zod'
import { loginD1 } from './login'
import { completeD1MfaChallenge } from './mfa-completion'
import { hashSecurityNetworkValue } from './security-anomalies'
import { issueD1SessionCookie, revokeD1Session, validateSessionCookieConfiguration } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'
import { canonicalAddress, checkAdministrativeEdgeLimit } from './edge-limit'
import { consumeAuthenticationQuota } from './anonymous-quota'
import { readD1AccountProfile, readD1UserSession, updateD1CustomerProfile } from './profile'
import { submitD1CompanyDetails } from './company'
import {
  createD1CustomerAddress,
  deleteD1CustomerAddress,
  listD1CustomerAddresses,
  updateD1CustomerAddress
} from './address-book'
import { addressInputSchema } from '../../server/domain/customer'
import { validateCloudflareCustomerAddress } from '../../shared/customer-tax-validation'
import { changeD1Password, listD1AccountSessions, revokeD1AccountSession } from './security'
import { beginD1MfaEnrollment, verifyD1MfaEnrollment } from './mfa-enrollment'

export interface AuthenticationHttpDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  configuration: () =>
    (SessionCookieConfiguration & { origin: string; tokenPepper: string; encryptionKey: string }) | null
}
const paths = [
  '/api/auth/login',
  '/api/auth/mfa/complete',
  '/api/auth/mfa/setup',
  '/api/auth/mfa/verify-setup',
  '/api/auth/logout',
  '/api/_auth/session',
  '/api/account',
  '/api/account/profile',
  '/api/account/company',
  '/api/account/addresses',
  '/api/account/password',
  '/api/account/sessions'
]
const loginSchema = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) })
  .strict()
const mfaSchema = z
  .object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43,86}$/), code: z.string().trim().min(6).max(32) })
  .strict()
const mfaSetupSchema = z.object({ currentPassword: z.string().min(1).max(128) }).strict()
const mfaVerifySetupSchema = z.object({ setupId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict()
const profileSchema = z
  .object({ name: z.string().trim().min(2).max(160), phone: z.string().max(32).nullable().optional() })
  .strict()
const companySchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    tradeName: z.string().trim().max(200).optional().default(''),
    taxId: z.string().trim().min(3).max(32),
    countryCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
    currentPassword: z.string().min(1).max(128)
  })
  .strict()
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z
      .string()
      .min(12)
      .max(128)
      .regex(/[a-záéíóúñ]/i)
      .regex(/\d/)
  })
  .strict()
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
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
async function readJson(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError(415, 'json_required')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) throw new BodyError(413, 'body_too_large')
  if (!request.body) throw new BodyError(400, 'invalid_body')
  const reader = request.body.getReader()
  const bytes = new Uint8Array(4096)
  let offset = 0
  try {
    while (true) {
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

export async function handleAuthenticationHttp(
  request: Request,
  deps: AuthenticationHttpDependencies
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const addressItem = /^\/api\/account\/addresses\/([^/]+)$/.exec(path)
  const accountSessionItem = /^\/api\/account\/sessions\/([^/]+)$/.exec(path)
  if (!paths.includes(path) && !addressItem && !accountSessionItem) return null
  const sessionRoute = path === '/api/_auth/session'
  const sessionRead = sessionRoute && request.method === 'GET'
  const accountRead = path === '/api/account' && request.method === 'GET'
  const addressCollection = path === '/api/account/addresses'
  const addressRead = addressCollection && request.method === 'GET'
  const sessionsRead = path === '/api/account/sessions' && request.method === 'GET'
  const profileWrite = path === '/api/account/profile' && request.method === 'PUT'
  const companyWrite = path === '/api/account/company' && request.method === 'PUT'
  const passwordWrite = path === '/api/account/password' && request.method === 'PUT'
  const allowed = sessionRoute
    ? 'GET, DELETE'
    : addressItem
      ? 'PUT, DELETE'
      : accountSessionItem
        ? 'DELETE'
        : addressCollection
          ? 'GET, POST'
          : path === '/api/account' || path === '/api/account/sessions'
            ? 'GET'
            : path === '/api/account/profile' || path === '/api/account/company' || path === '/api/account/password'
              ? 'PUT'
              : 'POST'
  const allowedMethod = allowed.split(', ').includes(request.method)
  if (!allowedMethod) return error('method_not_allowed', 405, { allow: allowed })
  try {
    const configuration = deps.configuration()
    if (!configuration) return error('authentication_unavailable', 503)
    validateSessionCookieConfiguration(configuration)
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(configuration.encryptionKey) ||
      atob(configuration.encryptionKey).length !== 32 ||
      /^A{43}=$/.test(configuration.encryptionKey)
    )
      throw new Error('invalid_auth_encryption_configuration')
    if (configuration.tokenPepper.length < 32 || configuration.tokenPepper.startsWith('local-only-'))
      throw new Error('invalid_auth_token_pepper')
    const origin = new URL(configuration.origin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.origin) throw new Error('invalid_auth_origin')
    if (
      ((!(sessionRead || accountRead || addressRead || sessionsRead) || request.headers.has('origin')) &&
        request.headers.get('origin') !== configuration.origin) ||
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
    if (sessionRead) return json(await readD1UserSession(deps.database, request, configuration))
    if (accountRead) {
      const profile = await readD1AccountProfile(deps.database, request, configuration)
      return profile ? json({ profile }) : error('unauthenticated', 401)
    }
    if (sessionsRead) {
      const sessions = await listD1AccountSessions(deps.database, request, configuration)
      return sessions ? json({ sessions }) : error('unauthenticated', 401)
    }
    if (accountSessionItem) {
      if (!z.string().uuid().safeParse(accountSessionItem[1]).success) return error('invalid_id', 400)
      const result = await revokeD1AccountSession(deps.database, request, configuration, accountSessionItem[1]!)
      return result === 'revoked'
        ? json({ ok: true })
        : error(result, result === 'unauthenticated' ? 401 : result === 'current_session' ? 409 : 404)
    }
    if (addressRead) {
      const addresses = await listD1CustomerAddresses(deps.database, request, configuration)
      return addresses ? json({ addresses }) : error('unauthenticated', 401)
    }
    if (addressCollection || addressItem) {
      if (addressItem && !z.string().uuid().safeParse(addressItem[1]).success) return error('invalid_id', 400)
      const raw = request.method === 'DELETE' ? null : await readJson(request)
      // Validate before schema trimming can erase forbidden edge controls.
      // Keep the raw object for strict unknown-field rejection below.
      if (request.method !== 'DELETE') validateCloudflareCustomerAddress(raw)
      const parsed = request.method === 'DELETE' ? null : addressInputSchema.strict().safeParse(raw)
      if (parsed && !parsed.success) return error('invalid_body', 400)
      const result = addressCollection
        ? await createD1CustomerAddress(deps.database, request, configuration, parsed!.data)
        : request.method === 'PUT'
          ? await updateD1CustomerAddress(deps.database, request, configuration, addressItem![1]!, parsed!.data)
          : await deleteD1CustomerAddress(deps.database, request, configuration, addressItem![1]!)
      if (!result.ok)
        return error(result.code, result.code === 'unauthenticated' ? 401 : result.code === 'address_limit' ? 409 : 404)
      return addressCollection ? json({ id: result.id }, 201) : json({ ok: true })
    }
    if (profileWrite) {
      const parsed = profileSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      const phone = parsed.data.phone?.trim() || null
      if (phone && phone.length < 6) return error('invalid_body', 400)
      const updated = await updateD1CustomerProfile(deps.database, request, configuration, {
        name: parsed.data.name,
        phone
      })
      if (!updated) return error('unauthenticated', 401)
      const refreshed = await readD1UserSession(deps.database, request, configuration)
      return 'user' in refreshed ? json({ user: refreshed.user }) : error('unauthenticated', 401)
    }
    if (companyWrite) {
      const parsed = companySchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      const result = await submitD1CompanyDetails(deps.database, request, configuration, parsed.data)
      if (!result.ok) {
        const status =
          result.code === 'rate_limited'
            ? 429
            : result.code === 'duplicate_tax_id'
              ? 409
              : result.code === 'invalid_tax_id'
                ? 400
                : result.code === 'email_unverified' || result.code === 'mfa_required'
                  ? 403
                  : 401
        return error(result.code, status, result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {})
      }
      const refreshed = await readD1UserSession(deps.database, request, configuration)
      return 'user' in refreshed
        ? json({ companyId: result.companyId, status: result.status, user: refreshed.user })
        : error('unauthenticated', 401)
    }
    if (passwordWrite) {
      const parsed = passwordSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      const result = await changeD1Password(deps.database, request, configuration, parsed.data)
      if (!result.ok)
        return error(
          result.code,
          result.code === 'rate_limited'
            ? 429
            : result.code === 'mfa_required'
              ? 403
              : result.code === 'same_password'
                ? 400
                : result.code === 'conflict'
                  ? 409
                  : 401,
          result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}
        )
      const cookie = await issueD1SessionCookie(deps.database, result, configuration)
      if (!cookie) return error('unauthenticated', 401)
      const refreshedRequest = new Request(request.url, { headers: { cookie: cookie.split(';')[0]! } })
      const refreshed = await readD1UserSession(deps.database, refreshedRequest, configuration)
      return 'user' in refreshed
        ? json({ ok: true, sessionVersion: result.sessionVersion, user: refreshed.user }, 200, {
            'set-cookie': cookie
          })
        : error('unauthenticated', 401)
    }
    if (path === '/api/auth/mfa/setup') {
      const parsed = mfaSetupSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      const result = await beginD1MfaEnrollment(deps.database, request, configuration, parsed.data.currentPassword)
      if (!result.ok)
        return error(
          result.code,
          result.code === 'rate_limited'
            ? 429
            : result.code === 'mfa_already_enabled'
              ? 409
              : result.code === 'email_unverified'
                ? 403
                : 401,
          result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}
        )
      return json({
        setupId: result.setupId,
        uri: result.uri,
        manualKey: result.manualKey,
        recoveryCodes: result.recoveryCodes
      })
    }
    if (path === '/api/auth/mfa/verify-setup') {
      const parsed = mfaVerifySetupSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      const result = await verifyD1MfaEnrollment(deps.database, request, configuration, parsed.data)
      if (!result.ok)
        return error(
          result.code,
          result.code === 'rate_limited' ? 429 : 401,
          result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}
        )
      return json({ ok: true })
    }
    if (path === '/api/auth/logout' || sessionRoute)
      return json({ ok: true }, 200, { 'set-cookie': await revokeD1Session(deps.database, request, configuration) })
    const scope = path === '/api/auth/login' ? 'login' : 'mfa-complete'
    async function quota(subject: string, kind: 'ip' | 'email') {
      try {
        const outcome = await consumeAuthenticationQuota(deps.database, {
          subject,
          kind,
          scope,
          pepper: configuration!.tokenPepper
        })
        return outcome.allowed ? null : error('rate_limited', 429, { 'retry-after': String(outcome.retryAfter) })
      } catch {
        return error('abuse_control_unavailable', 503)
      }
    }
    const denied = await quota(canonicalAddress(request.headers.get('cf-connecting-ip'))!, 'ip')
    if (denied) return denied
    const body = await readJson(request)
    let result
    if (scope === 'login') {
      const parsed = loginSchema.safeParse(body)
      if (!parsed.success) return error('invalid_body', 400)
      const accountDenied = await quota(parsed.data.email.toLowerCase(), 'email')
      if (accountDenied) return accountDenied
      result = await loginD1(deps.database, { ...parsed.data, tokenPepper: configuration.tokenPepper })
      if (!result.ok) return error(result.code, 401)
      if (result.kind === 'mfa_required')
        return json({ mfaRequired: true, challenge: result.challenge, expiresAt: result.expiresAt })
    } else {
      const parsed = mfaSchema.safeParse(body)
      if (!parsed.success) return error('invalid_body', 400)
      result = await completeD1MfaChallenge(deps.database, {
        ...parsed.data,
        tokenPepper: configuration.tokenPepper,
        encryptionKey: configuration.encryptionKey,
        // SEC-035: peppered hashes only (never raw IP/user-agent) for alert-only new-device signals.
        ipHash: await hashSecurityNetworkValue(
          canonicalAddress(request.headers.get('cf-connecting-ip')),
          `ip:${configuration.tokenPepper}`
        ),
        userAgentHash: await hashSecurityNetworkValue(
          request.headers.get('user-agent'),
          `ua:${configuration.tokenPepper}`
        )
      })
      if (!result.ok) return error(result.code, 401)
    }
    const cookie = await issueD1SessionCookie(deps.database, result, configuration)
    if (!cookie) return error('unauthenticated', 401)
    return json({ authenticated: true }, 200, { 'set-cookie': cookie })
  } catch (failure) {
    if (failure instanceof BodyError) return error(failure.code, failure.status)
    if (failure instanceof z.ZodError) return error('invalid_body', 400)
    return error('internal', 500)
  }
}
