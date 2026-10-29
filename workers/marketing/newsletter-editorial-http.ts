import { z } from 'zod'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { newsletterAdminInputSchema, newsletterPreferenceInputSchema } from '../../shared/newsletter-editorial'
import { verifySessionCookie } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit, canonicalAddress } from '../auth/edge-limit'
import {
  NewsletterEditorialError,
  assertEditorialEnabled,
  authorizeEditorial,
  editorialEpoch,
  editorialHash,
  type NewsletterEditorialHttpDependencies
} from './newsletter-editorial-core'
import { executeNewsletterEditorialAdmin, readNewsletterEditorialAdmin } from './newsletter-campaigns'
import { previewNewsletterCampaign } from './newsletter-campaign-render'
import { dispatchNewsletterCampaigns } from './newsletter-campaign-delivery'
import {
  readNewsletterPreferences,
  saveNewsletterPreferences,
  exchangeNewsletterConfirmationForPreferences,
  type NewsletterPreferenceAuthority
} from './newsletter-preferences'
import { receiveNewsletterEditorialFeedback } from './newsletter-campaign-feedback'
import { editorialMailbox } from './newsletter-campaign-transport'

export function ownsNewsletterEditorialNamespace(path: string) {
  let value = path
  for (let attempt = 0; attempt < 4; attempt++) {
    if (
      /^\/api\/(?:admin\/newsletter|account\/newsletter|newsletter\/preferences|webhooks\/newsletter)(?:[/\\%]|$)/.test(
        value
      )
    )
      return true
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) return false
      value = decoded
    } catch {
      return false
    }
  }
  return false
}
class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
async function bodyText(request: Request, max: number) {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new HttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new HttpError('json_required', 415)
  if (!request.body) throw new HttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(max)
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > max - size) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError('body_too_large', 413)
      }
      bytes.set(part.value, size)
      size += part.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } catch {
    throw new HttpError('invalid_json', 400)
  }
}
async function body(request: Request, max = 262144): Promise<unknown> {
  try {
    return JSON.parse(await bodyText(request, max))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError('invalid_json', 400)
  }
}
async function quota(
  deps: NewsletterEditorialHttpDependencies,
  subject: string,
  scope: 'admin' | 'account' | 'bearer' | 'preview' | 'dispatch'
) {
  const pepper = deps.rateLimitPepper
  if (typeof pepper !== 'string' || pepper.length < 32 || pepper.startsWith('local-only-'))
    throw new HttpError('abuse_control_unavailable', 503)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`neteco:newsletter:editorial:quota:v1:${scope}:${subject}`)
      )
    ),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  const now = editorialEpoch(deps),
    limit = scope === 'dispatch' || scope === 'preview' ? 20 : 120
  const row = await deps.database
    .prepare(
      `INSERT INTO newsletter_editorial_limits(subject_hash,scope,used,expires_at) VALUES (?1,?2,1,?3+3600)
 ON CONFLICT(subject_hash,scope) DO UPDATE SET used=CASE WHEN expires_at<=?3 THEN 1 ELSE min(used+1,?4+1) END,
 expires_at=CASE WHEN expires_at<=?3 THEN ?3+3600 ELSE expires_at END RETURNING used`
    )
    .bind(hash, scope, now, limit)
    .first()
  const value = z
    .object({ used: z.number().int().min(1).max(121) })
    .strict()
    .safeParse(row)
  if (!value.success) throw new HttpError('abuse_control_unavailable', 503)
  if (value.data.used > limit) throw new HttpError('rate_limited', 429)
}

/** Separate namespace: normal runtime remains OFF and cannot fall into Node. */
export async function handleNewsletterEditorialHttp(
  request: Request,
  deps: NewsletterEditorialHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  if (!ownsNewsletterEditorialNamespace(path)) return null
  const admin = path === '/api/admin/newsletter' || path.startsWith('/api/admin/newsletter/'),
    preference = path === '/api/account/newsletter/preferences' || path === '/api/newsletter/preferences',
    access = path === '/api/newsletter/preferences/access',
    feedback = path === '/api/webhooks/newsletter',
    match =
      /^\/api\/admin\/newsletter\/(policy|topics|campaigns)(?:\/([a-f0-9-]{36}))?(?:\/(approve|cancel|preview|test|dispatch))?$/.exec(
        path
      )
  if (!preference && !access && !feedback && path !== '/api/admin/newsletter' && !match)
    return json({ error: { code: 'invalid_input' } }, 400)
  if (match?.[2] && !catalogPolicyUuidSchema.safeParse(match[2]).success)
    return json({ error: { code: 'invalid_input' } }, 400)
  const operation = match?.[3],
    group = match?.[1],
    target = match?.[2] ?? null
  if ((operation && (!target || group !== 'campaigns')) || (group === 'policy' && target))
    return json({ error: { code: 'invalid_input' } }, 400)
  const methods =
    feedback || access
      ? ['POST']
      : preference
        ? ['GET', 'PUT']
        : path === '/api/admin/newsletter' || operation === 'preview'
          ? ['GET']
          : group === 'policy' && !target && !operation
            ? ['POST']
            : group === 'topics' && !operation
              ? target
                ? ['PUT']
                : ['POST']
              : group === 'campaigns'
                ? operation && target
                  ? ['POST']
                  : target
                    ? ['PUT']
                    : ['POST']
                : []
  if (!methods.includes(request.method))
    return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: methods.join(', ') })
  const cursor = url.searchParams.get('cursor')
  if (
    url.searchParams.size &&
    (path !== '/api/admin/newsletter' ||
      url.searchParams.size !== 1 ||
      url.searchParams.getAll('cursor').length !== 1 ||
      !catalogPolicyUuidSchema.safeParse(cursor).success)
  )
    return json({ error: { code: 'invalid_input' } }, 400)
  try {
    assertEditorialEnabled(deps)
    if (url.origin !== deps.publicOrigin) throw new HttpError('origin_rejected', 403)
    if (feedback)
      return json(
        await receiveNewsletterEditorialFeedback(
          deps,
          await bodyText(request, 4096),
          request.headers.get('x-neteco-email-signature')
        )
      )
    const read = request.method === 'GET'
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (!read && request.headers.get('origin') !== deps.publicOrigin) ||
      (read && request.headers.has('origin') && request.headers.get('origin') !== deps.publicOrigin)
    )
      throw new HttpError('csrf_rejected', 403)
    if (access) {
      if (!deps.edgeLimiter || !deps.rateLimitPepper) throw new HttpError('abuse_control_unavailable', 503)
      const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'newsletter')
      if (edge !== 'allowed')
        throw new HttpError(
          edge === 'limited' ? 'rate_limited' : 'abuse_control_unavailable',
          edge === 'limited' ? 429 : 503
        )
      // Persisted HMAC IP quota as well as the location edge gate. Varying a
      // forged token or extra JSON field cannot reset the durable counter.
      const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
      if (!address) throw new HttpError('abuse_control_unavailable', 503)
      await quota(deps, `access:${address}`, 'bearer')
      const input = await body(request, 1024)
      return json(await exchangeNewsletterConfirmationForPreferences(deps, input))
    }
    let authority: NewsletterPreferenceAuthority | undefined
    if (path === '/api/newsletter/preferences') {
      const header = request.headers.get('authorization')
      if (!header || !/^Bearer np1\.[a-f0-9-]{36}\.[1-9]\d{9}\.[a-f0-9]{64}$/.test(header))
        throw new HttpError('unauthenticated', 401)
      authority = { type: 'bearer', token: header.slice(7) }
      // Verify ownership before rate limits/body parsing; never echo the bearer.
      await readNewsletterPreferences(deps, authority)
    }
    const claims = authority ? null : deps.session ? await verifySessionCookie(request, deps.session) : null
    if (!authority && !claims)
      throw new HttpError(deps.session ? 'unauthenticated' : 'configuration_unavailable', deps.session ? 401 : 503)
    if (admin) await authorizeEditorial(deps, claims!)
    else {
      authority ??= { type: 'account', claims: claims! }
      if (path !== '/api/newsletter/preferences') await readNewsletterPreferences(deps, authority)
    }
    if (!deps.edgeLimiter || !deps.rateLimitPepper) throw new HttpError('abuse_control_unavailable', 503)
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'newsletter')
    if (edge !== 'allowed')
      throw new HttpError(
        edge === 'limited' ? 'rate_limited' : 'abuse_control_unavailable',
        edge === 'limited' ? 429 : 503
      )
    await quota(
      deps,
      claims?.identityId ?? (await editorialHash(authority!.type === 'bearer' ? authority!.token : '')),
      admin
        ? operation === 'dispatch'
          ? 'dispatch'
          : operation === 'test'
            ? 'preview'
            : 'admin'
        : authority!.type === 'bearer'
          ? 'bearer'
          : 'account'
    )
    if (preference) {
      if (read) return json(await readNewsletterPreferences(deps, authority!))
      const input = newsletterPreferenceInputSchema.safeParse(await body(request, 4096))
      if (!input.success) throw new HttpError('invalid_input', 422)
      return json(
        await saveNewsletterPreferences(deps, authority!, input.data, request.headers.get('idempotency-key') ?? '')
      )
    }
    if (path === '/api/admin/newsletter')
      return json(await readNewsletterEditorialAdmin(deps, claims!, cursor ?? undefined))
    if (operation === 'preview') return json(await previewNewsletterCampaign(deps, claims!, target!))
    if (operation === 'dispatch' || operation === 'test') {
      if (
        !z
          .object({})
          .strict()
          .safeParse(await body(request, 1024)).success
      )
        throw new HttpError('invalid_input', 422)
      await authorizeEditorial(deps, claims!)
      if (operation === 'dispatch')
        return json(await dispatchNewsletterCampaigns(deps, { campaignId: target!, limit: 25 }))
      if (
        deps.transport?.environment !== 'local' ||
        !/\.(test|invalid)$/.test(url.hostname) ||
        !deps.previewSenderFactory
      )
        throw new HttpError('preview_send_unavailable', 501)
      const preview = await previewNewsletterCampaign(deps, claims!, target!),
        sender = deps.previewSenderFactory()
      if (!sender || sender.kind !== 'local-fake') throw new HttpError('preview_send_unavailable', 501)
      const from = deps.transport.from
      if (!editorialMailbox(from) || !/\.(test|invalid)$/i.test(from))
        throw new HttpError('preview_send_unavailable', 501)
      await authorizeEditorial(deps, claims!)
      let receipt: unknown
      try {
        receipt = await sender.send({
          deliveryId: crypto.randomUUID(),
          to: 'preview@example.invalid',
          from,
          subject: preview.subject,
          html: preview.html,
          text: preview.text,
          headers: { 'List-Unsubscribe': '<https://preview.invalid/disabled>' }
        })
      } catch {
        throw new HttpError('preview_outcome_unknown', 409)
      }
      if (
        !z
          .object({ messageId: z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/) })
          .strict()
          .safeParse(receipt).success
      )
        throw new HttpError('preview_outcome_unknown', 409)
      return json({
        source: 'cloudflare',
        synthetic: true,
        externalDelivery: false,
        acceptedLocal: true,
        delivered: false
      })
    }
    const input = newsletterAdminInputSchema.safeParse(await body(request))
    const expected =
      group === 'policy'
        ? ['set_policy', 'retire_policy']
        : group === 'topics'
          ? [target ? 'update_topic' : 'create_topic']
          : [
              operation === 'approve'
                ? 'approve_campaign'
                : operation === 'cancel'
                  ? 'cancel_campaign'
                  : target
                    ? 'update_campaign'
                    : 'create_campaign'
            ]
    if (!input.success || !expected.includes(input.data.action)) throw new HttpError('invalid_input', 422)
    return json(
      await executeNewsletterEditorialAdmin(
        deps,
        claims!,
        target,
        input.data,
        request.headers.get('idempotency-key') ?? ''
      ),
      !target && group !== 'policy' ? 201 : 200
    )
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: { code: error.code } }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {})
    if (error instanceof NewsletterEditorialError) {
      const status = ['unauthenticated', 'feedback_unauthenticated'].includes(error.code)
        ? 401
        : ['forbidden', 'email_unverified', 'mfa_required'].includes(error.code)
          ? 403
          : ['not_found', 'receipt_unknown'].includes(error.code)
            ? 404
            : ['invalid_input', 'invalid_window', 'editorial_ratio'].includes(error.code)
              ? 422
              : [
                    'version_conflict',
                    'idempotency_conflict',
                    'not_editable',
                    'consent_unavailable',
                    'topic_unavailable',
                    'source_unavailable',
                    'policy_unavailable'
                  ].includes(error.code)
                ? 409
                : error.code === 'feature_unavailable' || error.code === 'feedback_unavailable'
                  ? 501
                  : 503
      return json({ error: { code: error.code } }, status)
    }
    return json({ error: { code: 'read_unconfirmed' } }, 503)
  }
}
