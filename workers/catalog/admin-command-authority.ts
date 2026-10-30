import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export type AdminAuthorityFailure = 'unauthenticated' | 'forbidden'

/**
 * Fresh, server-clocked check of an MFA administrator holding administration.manage.
 * Identity and time never come from the client. Returns the failure instead of
 * throwing so each domain maps it to its own error class.
 */
export async function checkAdminAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<{ ok: true; actorId: string } | { ok: false; code: AdminAuthorityFailure }> {
  if (!claims) return { ok: false, code: 'unauthenticated' }
  const result = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: true })
  if (result.allowed) return { ok: true, actorId: result.identityId }
  return { ok: false, code: result.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden' }
}

export function serverNow(provided?: () => string): string {
  return provided ? provided() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function isConstraintFailure(error: unknown, ...markers: string[]): boolean {
  const message = error instanceof Error ? `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}` : ''
  return markers.some((marker) => message.includes(marker))
}
