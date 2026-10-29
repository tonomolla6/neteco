import { authorizeD1Session, type AuthorizationResult } from '../catalog/authorization'
import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'

/** Read-only authentication/authorization boundary. Mutating HTTP handlers must
 * additionally enforce CSRF, request limits and resource ownership as required.
 */
export async function authorizeAdministrativeRequest(
  request: Request,
  database: D1Database,
  configuration: SessionCookieConfiguration,
  permission: string
): Promise<AuthorizationResult> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return { allowed: false, code: 'unauthenticated' }
  return authorizeD1Session(database, claims, permission, { requireMfa: true })
}
