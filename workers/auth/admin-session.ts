import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'

/** Authenticate the exact cookie session before any administrative data access.
 * Role names cached in cookies and other sessions of this identity confer no authority.
 */
export async function authorizeD1AdminCookie(
  request: Request,
  options: {
    database: D1Database
    configuration: SessionCookieConfiguration | null | undefined
    permissions?: readonly string[]
    now?: string
  }
): Promise<{ allowed: true; claims: VerifiedSessionClaims } | { allowed: false; code: string; status: number }> {
  if (!/(?:^|;\s*)neteco-session=/.test(request.headers.get('cookie') ?? ''))
    return { allowed: false, code: 'unauthorized', status: 401 }
  if (!options.configuration) return { allowed: false, code: 'service_unavailable', status: 503 }
  try {
    const claims = await verifySessionCookie(request, options.configuration)
    if (!claims) return { allowed: false, code: 'unauthorized', status: 401 }
    for (const permission of options.permissions ?? ['administration.manage']) {
      const authorization = await authorizeD1Session(options.database, claims, permission, {
        now: options.now,
        requireMfa: true
      })
      if (authorization.allowed) return { allowed: true, claims }
      if (authorization.code === 'forbidden') continue
      return {
        allowed: false,
        code: authorization.code,
        status: authorization.code === 'unauthenticated' ? 401 : 403
      }
    }
    return { allowed: false, code: 'forbidden', status: 403 }
  } catch {
    return { allowed: false, code: 'service_unavailable', status: 503 }
  }
}
