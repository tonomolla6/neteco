import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

/**
 * Live authorization for release/CMS admin endpoints: roles, MFA and session state are read
 * from D1 on every request (never from the cookie), so a revoked role stops working at once.
 * Returns null when allowed, otherwise the stable error status/code to answer with.
 */
export async function denyUnlessAdmin(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permissions: readonly string[],
  now: string
): Promise<{ status: 401 | 403; code: string } | null> {
  let denial: { status: 401 | 403; code: string } = { status: 403, code: 'forbidden' }
  for (const permission of permissions) {
    const result = await authorizeD1Session(database, claims, permission, { now, requireMfa: true })
    if (result.allowed) return null
    if (result.code === 'unauthenticated') return { status: 401, code: 'unauthenticated' }
    if (result.code === 'mfa_required' || result.code === 'email_unverified')
      denial = { status: 403, code: result.code }
  }
  return denial
}

/** Second-resolution UTC instant, the only format D1 timestamps and authorizeD1Session accept. */
export function serverInstant(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Parsed JSON body, or undefined when the payload is not valid JSON (callers answer 400 invalid_json).
 * Typed `any` like Request.json(): every service validates the shape with zod at its own boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
