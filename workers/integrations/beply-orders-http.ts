import type { z } from 'zod'
import { fiscalUuid, fiscalInstant } from '../../shared/fiscal-issuance'
import { fiscalClock } from '../fiscal/issuance'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { beplyRetrySchema, readBeplyOrder, retryBeplyOrder } from './beply-orders'

export interface BeplyOrdersHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  now?: () => string
}
const headers = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
const error = (code: string, status: number) => Response.json({ error: { code } }, { status, headers })
async function body(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new Error('invalid_body')
  const limit = 8192,
    length = request.headers.get('content-length')
  if ((length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) || !request.body)
    throw new Error('invalid_body')
  const reader = request.body.getReader(),
    bytes = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (part.value.length > limit - size) {
        void reader.cancel().catch(() => {})
        throw new Error('invalid_body')
      }
      bytes.set(part.value, size)
      size += part.value.length
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } finally {
    reader.releaseLock()
  }
}
/** Pure ownership test, usable before any D1/session work or rate limiting. */
export function ownsBeplyOrdersNamespace(pathname: string): boolean {
  let decoded = pathname
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/(?:admin\/)?orders\/[^/]+\/beply(?:[/\\%]|$)/.test(decoded)) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return false
}
export async function handleBeplyOrdersRequest(
  request: Request,
  deps: BeplyOrdersHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = /^\/api\/(admin\/)?orders\/([^/]+)\/beply(?:\/(retry))?$/.exec(url.pathname)
  if (!match) return ownsBeplyOrdersNamespace(url.pathname) ? error('not_found', 404) : null
  const admin = Boolean(match[1]),
    retry = Boolean(match[3]),
    orderId = match[2]!
  if (!fiscalUuid.safeParse(orderId).success || (retry && !admin)) return error('not_found', 404)
  if (request.method !== (retry ? 'POST' : 'GET')) return error('method_not_allowed', 405)
  if (url.search) return error('invalid_input', 400)
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
    (retry && request.headers.get('origin') !== deps.origin)
  )
    return error('csrf_rejected', 403)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin) return error('service_unavailable', 503)
    if (url.origin !== deps.origin) return error('csrf_rejected', 403)
    const now = fiscalClock(fiscalInstant.parse(deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')))
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    if (retry) {
      let input: z.infer<typeof beplyRetrySchema>
      try {
        input = beplyRetrySchema.parse(await body(request))
      } catch {
        return error('invalid_input', 400)
      }
      return Response.json(await retryBeplyOrder(deps.database, claims, orderId, input, now()), {
        status: 202,
        headers
      })
    }
    return Response.json(
      await readBeplyOrder(deps.database, { kind: admin ? 'admin' : 'customer', claims }, orderId, now()),
      { headers }
    )
  } catch (cause) {
    const code = cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, 'code')?.value : undefined
    if (['unauthenticated', 'session_expired', 'session_revoked'].includes(code)) return error('unauthenticated', 401)
    if (['forbidden', 'mfa_required'].includes(code)) return error(code, 403)
    if (code === 'not_found') return error(code, 404)
    if (code === 'version_conflict' || code === 'idempotency_conflict') return error(code, 409)
    return error('service_unavailable', 503)
  }
}
