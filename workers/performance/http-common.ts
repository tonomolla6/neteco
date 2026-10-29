import type { ZodType } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { PerformanceInsightError } from '../../shared/performance-insights-error'

export interface InsightsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
}

export const INSIGHTS_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive'
}

export function ownsPath(path: string, prefix: RegExp): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (prefix.test(value)) return true
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return false
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: INSIGHTS_HEADERS })
}
export function errorJson(code: string, status: number, message?: string): Response {
  return json({ error: { code, message: message ?? code } }, status)
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new PerformanceInsightError('invalid_request', 400, 'Invalid JSON body')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new PerformanceInsightError('invalid_input', 400, parsed.error.issues[0]?.message)
  return parsed.data
}

/** Authenticates, rejects cross-origin mutations and authorizes live. Returns claims or a Response. */
export async function guard(
  request: Request,
  deps: InsightsHttpDependencies
): Promise<{ claims: VerifiedSessionClaims; now: string | undefined } | Response> {
  const claims = deps.claimsResolver
    ? await deps.claimsResolver(request)
    : await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return errorJson('unauthenticated', 401)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== deps.origin) return errorJson('origin_forbidden', 403)
  }
  const now = deps.now?.()
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
  if (!auth.allowed) return errorJson(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  return { claims, now }
}

export function mapError(error: unknown): Response {
  if (error instanceof PerformanceInsightError) return errorJson(error.code, error.statusCode, error.message)
  return errorJson('internal_error', 500)
}
