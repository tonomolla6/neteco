import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import { SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { canonicalAddress, checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { readJson } from '../catalog/storefront-cart'
import {
  confirmNewsletterConsent,
  requestNewsletterConsent,
  unsubscribeNewsletterConsent,
  type NewsletterSecrets
} from './newsletter'

interface NewsletterHttpDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  rateLimitPepper: string
  configuration: () => { secrets: NewsletterSecrets; publicOrigin: string } | null
  /** Optional maintenance authority: unsubscribing needs no acquisition or
   * email-delivery permission. Absent preserves the existing caller contract. */
  unsubscribeConfiguration?: () => { secrets: NewsletterSecrets; publicOrigin: string } | null
  now?: () => number
}

const routes: Record<string, 'subscribe' | 'confirm' | 'unsubscribe'> = {
  '/api/newsletter/subscribe': 'subscribe',
  '/api/newsletter/confirm': 'confirm',
  '/api/newsletter/unsubscribe': 'unsubscribe'
}

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactly(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value)
}

async function consumeQuota(
  database: D1Database,
  address: string,
  pepper: string,
  scope: 'subscribe' | 'confirm' | 'unsubscribe',
  now: number
): Promise<boolean> {
  const policy = SENSITIVE_RATE_LIMIT_POLICIES[`newsletter-${scope}`]
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`neteco:newsletter:quota:v1:${scope}:${address}`)
  )
  const subject = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const row = await database
    .prepare(
      `INSERT INTO newsletter_request_limits(subject_hash, scope, used, expires_at)
       VALUES (?1, ?2, 1, ?3 + ?4)
       ON CONFLICT(subject_hash, scope) DO UPDATE SET
         used = CASE WHEN newsletter_request_limits.expires_at <= ?3 THEN 1
           ELSE min(newsletter_request_limits.used + 1, ?5 + 1) END,
         expires_at = CASE WHEN newsletter_request_limits.expires_at <= ?3 THEN ?3 + ?4
           ELSE newsletter_request_limits.expires_at END
       RETURNING used`
    )
    .bind(subject, scope, now, policy.windowSeconds, policy.limit)
    .first<{ used: number }>()
  if (!row) throw new Error('newsletter_quota_unavailable')
  return row.used <= policy.limit
}

export async function handleNewsletterHttp(
  request: Request,
  deps: NewsletterHttpDependencies
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const action = routes[path]
  if (!action) return null
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405, { allow: 'POST' })
  try {
    const configuration =
      action === 'unsubscribe' && deps.unsubscribeConfiguration ? deps.unsubscribeConfiguration() : deps.configuration()
    if (!configuration) return json({ error: { code: 'newsletter_unavailable' } }, 503)
    const origin = new URL(request.url).origin
    if (
      origin !== configuration.publicOrigin ||
      request.headers.get('origin') !== origin ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return json({ error: { code: 'csrf_rejected' } }, 403)
    const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
    if (!address || deps.rateLimitPepper.length < 32 || deps.rateLimitPepper.startsWith('local-only-'))
      return json({ error: { code: 'abuse_control_unavailable' } }, 503)
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'newsletter')
    if (edge === 'unavailable') return json({ error: { code: 'abuse_control_unavailable' } }, 503)
    if (edge === 'limited') return json({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '60' })
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(now) || now < 1_000_000_000)
      return json({ error: { code: 'newsletter_unavailable' } }, 503)
    const body = await readJson(request)
    if (!isPlainObject(body)) return json({ error: { code: 'invalid_body' } }, 400)
    if (action === 'subscribe') {
      if (
        !hasExactly(body, ['email', 'consent', 'source', 'website'], ['email', 'consent']) ||
        typeof body.email !== 'string' ||
        body.consent !== true ||
        body.email.trim().length > 254 ||
        !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(body.email.trim()) ||
        body.email.includes('..') ||
        (body.source !== undefined && body.source !== 'footer') ||
        (body.website !== undefined && (typeof body.website !== 'string' || body.website.length > 200))
      )
        return json({ error: { code: 'invalid_body' } }, 400)
      const accepted = {
        ok: true,
        message: 'Si la dirección es elegible, recibirás un email para confirmar la suscripción.'
      }
      if (body.website) return json(accepted, 202)
      if (!(await consumeQuota(deps.database, address, deps.rateLimitPepper, action, now)))
        return json({ error: { code: 'rate_limited' } }, 429)
      await requestNewsletterConsent(
        deps.database,
        {
          email: body.email,
          purpose: 'newsletter',
          consentText: NEWSLETTER_CONSENT_TEXT,
          consentVersion: NEWSLETTER_POLICY_VERSION,
          consentSource: 'footer',
          idempotencyKey: crypto.randomUUID(),
          now
        },
        configuration.secrets
      )
      return json(accepted, 202)
    }
    if (!hasExactly(body, ['token'], ['token']) || typeof body.token !== 'string' || body.token.length > 256)
      return json({ error: { code: 'invalid_body' } }, 400)
    if (!(await consumeQuota(deps.database, address, deps.rateLimitPepper, action, now)))
      return json({ error: { code: 'rate_limited' } }, 429)
    if (action === 'confirm') await confirmNewsletterConsent(deps.database, body.token, configuration.secrets, now)
    else await unsubscribeNewsletterConsent(deps.database, body.token, configuration.secrets, now)
    // Invalid, expired and already-used links are intentionally indistinguishable.
    return json({ ok: true }, 200)
  } catch {
    return json({ error: { code: 'internal' } }, 500)
  }
}
