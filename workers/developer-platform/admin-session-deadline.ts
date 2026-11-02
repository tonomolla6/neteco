import { defaults, unseal } from 'iron-webcrypto'
import { ironCrypto } from '../auth/iron-crypto'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'

/** Read the deadline from the same authenticated envelope as the session claims.
 * The caller has already verified the cookie; re-check the bound claims before
 * using its deadline in the database's atomic authority predicate. */
export async function verifiedAdminCookieDeadline(
  request: Request,
  configuration: SessionCookieConfiguration,
  claims: VerifiedSessionClaims
): Promise<number | null> {
  const header = request.headers.get('cookie')
  if (!header || header.length > 8192) return null
  let sealed: string | undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== 'neteco-session') continue
    if (sealed !== undefined) return null
    try {
      sealed = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  if (!sealed || sealed.length > 4096) return null
  try {
    const envelope = (await unseal(ironCrypto, sealed, configuration.password, {
      ...defaults,
      ttl: configuration.maxAgeSeconds * 1000
    })) as unknown
    if (!envelope || typeof envelope !== 'object') return null
    const outer = envelope as Record<string, unknown>
    if (
      !Number.isSafeInteger(outer.createdAt) ||
      typeof outer.createdAt !== 'number' ||
      !outer.data ||
      typeof outer.data !== 'object'
    )
      return null
    const data = outer.data as Record<string, unknown>
    if (!data.user || typeof data.user !== 'object') return null
    const user = data.user as Record<string, unknown>
    if (
      data.sessionId !== claims.sessionId ||
      data.sessionVersion !== claims.sessionVersion ||
      user.id !== claims.identityId
    )
      return null
    const deadline = outer.createdAt + configuration.maxAgeSeconds * 1000
    return Number.isSafeInteger(deadline) ? deadline : null
  } catch {
    return null
  }
}
