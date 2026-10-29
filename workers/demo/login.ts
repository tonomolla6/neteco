import { z } from 'zod'
import { DEMO_IDENTITIES, DEMO_ORIGIN } from '../../shared/demo-access'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { issueD1SessionCookie, validateSessionCookieConfiguration } from '../auth/session-cookie'
import { readD1UserSession } from '../auth/profile'
import { authorizeD1Session } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'

export type DemoLoginEnv = Pick<
  CloudflareEnv,
  | 'APP_ENV'
  | 'AUTH_ENABLED'
  | 'AUTH_ORIGIN'
  | 'AUTH_EDGE_LIMIT'
  | 'AUTH_RATE_LIMIT_PEPPER'
  | 'NUXT_SESSION_PASSWORD'
  | 'DB'
> & { DEMO_ENABLED?: unknown }

class DemoLoginError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      Vary: 'Cookie, Origin',
      ...headers
    }
  })
}
function ownsNamespace(pathname: string) {
  let path = pathname
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/demo(?:[/\\%]|$)/i.test(path)) return true
    try {
      const next = decodeURIComponent(path)
      if (next === path) break
      path = next
    } catch {
      break
    }
  }
  return false
}
function assertEnabled(env: DemoLoginEnv, url: URL) {
  // Exact opt-ins and the exact host are checked before DB, body or secrets.
  // The deployment must separately bind an isolated demo D1 and signing key.
  if (
    env.APP_ENV !== 'preview' ||
    env.DEMO_ENABLED !== 'true' ||
    env.AUTH_ENABLED !== 'true' ||
    env.AUTH_ORIGIN !== DEMO_ORIGIN ||
    url.origin !== DEMO_ORIGIN
  )
    throw new DemoLoginError('demo_unavailable', 503)
}
const inputSchema = z.object({ role: z.enum(['customer', 'admin']) }).strict()
const sessionSchema = z
  .object({
    sessionId: catalogPolicyUuidSchema,
    identityId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    mfaVerified: z.union([z.literal(0), z.literal(1)])
  })
  .strict()
async function readInput(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new DemoLoginError('json_required', 415)
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > 256))
    throw new DemoLoginError('body_too_large', 413)
  if (!request.body) throw new DemoLoginError('invalid_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(256)
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new DemoLoginError('invalid_body', 400)
      if (size + next.value.byteLength > bytes.byteLength) {
        await reader.cancel().catch(() => undefined)
        throw new DemoLoginError('body_too_large', 413)
      }
      bytes.set(next.value, size)
      size += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return inputSchema.parse(
      catalogPolicyOwnJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))))
    )
  } catch {
    throw new DemoLoginError('invalid_body', 400)
  }
}
const liveNow = "strftime('%Y-%m-%dT%H:%M:%SZ','now')"
// Only the dedicated fixture identity/customer/role can receive this synthetic
// session. No account, permission, MFA enrollment or grant is created here.
const eligibleIdentity = `i.id=?1 AND i.email=?2 COLLATE BINARY AND i.customer_id=?3
  AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${liveNow}
  AND c.id=?3 AND c.status='active'
  AND EXISTS(SELECT 1 FROM identity_roles r WHERE r.identity_id=i.id AND r.role_code=?4
    AND r.granted_at<=${liveNow} AND (r.expires_at IS NULL OR r.expires_at>${liveNow}))
  AND NOT EXISTS(SELECT 1 FROM identity_roles other WHERE other.identity_id=i.id AND other.role_code<>?4
    AND other.granted_at<=${liveNow} AND (other.expires_at IS NULL OR other.expires_at>${liveNow}))
  AND (?4='customer' OR EXISTS(SELECT 1 FROM role_permissions g
    WHERE g.role_code='admin' AND g.permission_code='administration.manage'))`

/** Public synthetic access only on the explicitly isolated preview deployment.
 * The simulated admin MFA bit never alters normal password/TOTP authentication.
 * Claimed aliases and disabled routes never fall through to Node or another API.
 */
export async function handleDemoLoginRequest(request: Request, env: DemoLoginEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsNamespace(url.pathname)) return null
  try {
    assertEnabled(env, url)
    if (url.pathname !== '/api/demo/login' || url.searchParams.size) throw new DemoLoginError('invalid_path', 400)
    if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'POST' })
    if (request.headers.get('origin') !== DEMO_ORIGIN || request.headers.get('sec-fetch-site') !== 'same-origin')
      throw new DemoLoginError('csrf_rejected', 403)
    const limiter = env.AUTH_EDGE_LIMIT,
      pepper = env.AUTH_RATE_LIMIT_PEPPER
    const edge = await checkAdministrativeEdgeLimit(request, limiter, pepper, 'authentication')
    if (edge === 'limited') return json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') throw new DemoLoginError('abuse_control_unavailable', 503)
    assertEnabled(env, url)
    const input = await readInput(request)
    assertEnabled(env, url)
    const configuration = { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
    validateSessionCookieConfiguration(configuration)
    const rawDatabase = env.DB,
      database = guardedFiscalDatabase(rawDatabase)
    function assertCurrent() {
      assertEnabled(env, url)
      if (
        env.DB !== rawDatabase ||
        env.NUXT_SESSION_PASSWORD !== configuration.password ||
        env.AUTH_EDGE_LIMIT !== limiter ||
        env.AUTH_RATE_LIMIT_PEPPER !== pepper
      )
        throw new DemoLoginError('demo_unavailable', 503)
    }
    const identity = DEMO_IDENTITIES[input.role],
      sessionId = crypto.randomUUID(),
      mfa = input.role === 'admin' ? 1 : 0
    assertCurrent()
    const inserted = await database
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at,last_seen_at)
        SELECT ?5,i.id,i.session_version,?6,${liveNow},strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 hour'),${liveNow}
        FROM identities i JOIN customers c ON c.id=i.customer_id WHERE ${eligibleIdentity}
        RETURNING id AS sessionId,identity_id AS identityId,session_version AS sessionVersion,mfa_verified AS mfaVerified`
      )
      .bind(identity.identityId, identity.email, identity.customerId, input.role, sessionId, mfa)
      .first()
    assertCurrent()
    if (inserted === null) throw new DemoLoginError('demo_account_unavailable', 403)
    const session = sessionSchema.parse(inserted)
    if (session.sessionId !== sessionId || session.identityId !== identity.identityId || session.mfaVerified !== mfa)
      throw new DemoLoginError('service_unavailable', 503)
    const claims = { sessionId, identityId: identity.identityId, sessionVersion: session.sessionVersion }
    const cookie = await issueD1SessionCookie(database, claims, configuration)
    assertCurrent()
    if (!cookie) throw new DemoLoginError('unauthenticated', 401)
    const sessionRequest = new Request(request.url, { headers: { Cookie: cookie.split(';')[0]! } })
    const profile = await readD1UserSession(database, sessionRequest, configuration)
    assertCurrent()
    if (
      !('user' in profile) ||
      !profile.user ||
      profile.user.id !== identity.identityId ||
      profile.user.email !== identity.email ||
      profile.user.role !== input.role ||
      profile.user.roles.length !== 1 ||
      profile.user.roles[0] !== input.role ||
      profile.user.emailVerified !== true ||
      profile.user.mfaVerified !== (mfa === 1)
    )
      throw new DemoLoginError('demo_account_unavailable', 403)
    if (input.role === 'admin') {
      const authority = await authorizeD1Session(database, claims, 'administration.manage', { requireMfa: true })
      assertCurrent()
      if (!authority.allowed) throw new DemoLoginError(authority.code, authority.code === 'unauthenticated' ? 401 : 403)
    }
    // Recheck every eligibility field and the new session using the live SQL
    // clock after sealing/profile/auth awaits, before releasing any cookie.
    const current = await database
      .prepare(
        `SELECT s.id AS sessionId,i.id AS identityId,i.session_version AS sessionVersion,s.mfa_verified AS mfaVerified
        FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
        WHERE ${eligibleIdentity} AND s.id=?5 AND s.session_version=?7 AND i.session_version=?7
          AND s.mfa_verified=?6 AND s.revoked_at IS NULL AND s.created_at<=${liveNow} AND s.expires_at>${liveNow}`
      )
      .bind(
        identity.identityId,
        identity.email,
        identity.customerId,
        input.role,
        sessionId,
        mfa,
        session.sessionVersion
      )
      .first()
    assertCurrent()
    if (current === null) throw new DemoLoginError('demo_account_unavailable', 403)
    const confirmed = sessionSchema.parse(current)
    if (
      confirmed.sessionId !== sessionId ||
      confirmed.identityId !== identity.identityId ||
      confirmed.sessionVersion !== session.sessionVersion ||
      confirmed.mfaVerified !== mfa
    )
      throw new DemoLoginError('service_unavailable', 503)
    return json({ source: 'cloudflare', demo: true, role: input.role, identityId: identity.identityId }, 200, {
      'Set-Cookie': cookie
    })
  } catch (error) {
    return error instanceof DemoLoginError
      ? json({ error: { code: error.code } }, error.status)
      : json({ error: { code: 'service_unavailable' } }, 503)
  }
}
