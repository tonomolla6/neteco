import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { HighValueConsentError, readHighValueConsent } from './high-value-consent'
import { HighValueDeliveryError } from './high-value-delivery'
import { prepareHighValueMessage } from './high-value-fallback'
import { assertHighValueEventSource, highValueEventIdSchema, HighValueSourceError } from './high-value-source'

export interface HighValueMessagesHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
  pricing: unknown
  transport: string
}
const bodySchema = z
  .object({
    eventId: highValueEventIdSchema,
    event: z.enum(['recall', 'delivery_exception', 'security_alert']),
    channel: z.literal('sms'),
    consentVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export async function handleHighValueMessagesHttp(
  request: Request,
  deps: HighValueMessagesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/admin\/customers\/([^/]+)\/high-value-messages$/.exec(url.pathname)
  if (!match) return null
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
        ...extra
      }
    })
  const error = (code: string, status: number, extra?: Record<string, string>) =>
    json({ error: { code } }, status, extra)
  if (request.method !== 'POST') return error('method_not_allowed', 405, { Allow: 'POST' })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (url.searchParams.size) return error('invalid_input', 400)
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'admin-customer-context'
    )
    if (limited !== 'allowed')
      return error(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { now: deps.now }
    const key = request.headers.get('idempotency-key')
    if (
      !key ||
      !z.string().uuid().safeParse(key).success ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    )
      return error('invalid_input', 400)
    const length = request.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return error('invalid_input', 413)
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return error('invalid_input', 400)
    }
    const parsed = bodySchema.safeParse(input)
    if (!parsed.success) return error('invalid_input', 400)
    await readHighValueConsent(deps.database, claims, match[1]!, 'sms', options)
    await assertHighValueEventSource(
      deps.database,
      claims,
      match[1]!,
      { event: parsed.data.event, eventId: parsed.data.eventId },
      options
    )
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-high-value-messages',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    return json(
      await prepareHighValueMessage(deps.database, claims, match[1]!, key, parsed.data, {
        ...options,
        pricing: deps.pricing,
        transport: deps.transport,
        requireSource: true
      })
    )
  } catch (cause) {
    if (
      cause instanceof HighValueConsentError ||
      cause instanceof HighValueDeliveryError ||
      cause instanceof HighValueSourceError
    )
      return error(
        cause.code,
        cause.code === 'unauthenticated'
          ? 401
          : cause.code === 'not_found' || cause.code === 'event_unavailable'
            ? 404
            : cause.code === 'invalid_input'
              ? 400
              : cause.code === 'conflict'
                ? 409
                : cause.code === 'unavailable'
                  ? 503
                  : 403
      )
    return error('unavailable', 503)
  }
}
