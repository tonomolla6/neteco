import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newsletterEditorialFixture, newsletterCampaignDocument } from './d1-newsletter-editorial-fixture'
import {
  handleNewsletterEditorialHttp,
  ownsNewsletterEditorialNamespace
} from '../../workers/marketing/newsletter-editorial-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  requestNewsletterConsent,
  confirmNewsletterConsent,
  createNewsletterUnsubscribeToken,
  suppressNewsletterEmail
} from '../../workers/marketing/newsletter'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import { testUuid } from '../support/deterministic'

describe('newsletter editorial HTTP over D1', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>, cookie: string
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
    cookie = (await issueD1SessionCookie(w.database, w.claims, w.deps.session!))!.split(';')[0]!
  })
  afterEach(() => w.sqlite.close())
  const req = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(w.deps.publicOrigin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: w.deps.publicOrigin,
        'CF-Connecting-IP': '192.0.2.50',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': testUuid() }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  it.each([
    '/api/admin/newsletter',
    '/api/admin/newsletter/campaigns',
    '/api/account/newsletter/preferences',
    '/api/newsletter/preferences',
    '/api/webhooks/newsletter',
    '/api/admin%2Fnewsletter',
    '/api/admin/newsletter%2Fescape'
  ])('owns namespace %s', (path) => expect(ownsNewsletterEditorialNamespace(path)).toBe(true))
  it.each([
    '/api/newsletter/subscribe',
    '/api/newsletter/confirm',
    '/api/newsletter/unsubscribe',
    '/api/account/preferences',
    '/api/admin/newsletters'
  ])('preserves legacy namespace %s', async (path) =>
    expect(await handleNewsletterEditorialHttp(req(path), w.deps)).toBeNull()
  )
  it('defaults OFF even with a valid operator', async () => {
    expect(
      (await handleNewsletterEditorialHttp(req('/api/admin/newsletter'), { ...w.deps, enabled: undefined }))!.status
    ).toBe(501)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_commands').get()).toEqual({ n: 0 })
  })
  it('requires live cookie, permission/MFA and same origin', async () => {
    expect(
      (await handleNewsletterEditorialHttp(req('/api/admin/newsletter', 'GET', undefined, { Cookie: '' }), w.deps))!
        .status
    ).toBe(401)
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/admin/newsletter', 'GET', undefined, { Origin: 'https://evil.invalid' }),
        w.deps
      ))!.status
    ).toBe(403)
    w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(w.claims.sessionId)
    expect((await handleNewsletterEditorialHttp(req('/api/admin/newsletter'), w.deps))!.status).toBe(403)
  })
  it('confirms body, CAS and exact replay through real HTTP', async () => {
    const input = {
        action: 'create_campaign',
        expectedRevision: 0,
        document: newsletterCampaignDocument(),
        reason: 'Alta editorial de prueba'
      },
      key = testUuid(),
      request = () => req('/api/admin/newsletter/campaigns', 'POST', input, { 'Idempotency-Key': key })
    const created = await handleNewsletterEditorialHttp(request(), w.deps)
    expect(created!.status).toBe(201)
    const receipt = await created!.json()
    expect(await (await handleNewsletterEditorialHttp(request(), w.deps))!.json()).toEqual(receipt)
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/admin/newsletter/campaigns', 'POST', { ...input, reason: 'Otra razón' }, { 'Idempotency-Key': key }),
        w.deps
      ))!.status
    ).toBe(409)
    const read = await handleNewsletterEditorialHttp(req('/api/admin/newsletter'), w.deps)
    expect(read!.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.stringify(await read!.json())).not.toContain('cms@example.invalid')
  })
  it('rejects unknown/inherited fields, mismatched actions and invalid keys', async () => {
    const input = {
      action: 'create_campaign',
      expectedRevision: 0,
      document: newsletterCampaignDocument(),
      reason: 'Alta editorial'
    }
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/admin/newsletter/campaigns', 'POST', { ...input, consent: true }),
        w.deps
      ))!.status
    ).toBe(422)
    expect(
      (await handleNewsletterEditorialHttp(req('/api/admin/newsletter/topics', 'POST', input), w.deps))!.status
    ).toBe(422)
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/admin/newsletter/campaigns', 'POST', input, { 'Idempotency-Key': 'bad key' }),
        w.deps
      ))!.status
    ).toBe(422)
  })
  it('requires bearer in Authorization, never an email or query token', async () => {
    const sub = await w.subscriber(),
      good = req('/api/newsletter/preferences', 'GET', undefined, { Authorization: `Bearer ${sub.token}` })
    expect((await handleNewsletterEditorialHttp(good, w.deps))!.status).toBe(200)
    expect(
      (await handleNewsletterEditorialHttp(req('/api/newsletter/preferences?token=' + sub.token), w.deps))!.status
    ).toBe(400)
    expect((await handleNewsletterEditorialHttp(req('/api/newsletter/preferences'), w.deps))!.status).toBe(401)
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/account/newsletter/preferences', 'PUT', {
          action: 'save',
          expectedRevision: 1,
          email: 'other@example.invalid',
          preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
        }),
        w.deps
      ))!.status
    ).toBe(422)
  })
  it('fails closed without abuse controls and when edge-limited', async () => {
    expect(
      (await handleNewsletterEditorialHttp(req('/api/admin/newsletter'), { ...w.deps, edgeLimiter: undefined }))!.status
    ).toBe(503)
    expect(
      (await handleNewsletterEditorialHttp(req('/api/admin/newsletter'), {
        ...w.deps,
        edgeLimiter: { limit: async () => ({ success: false }) }
      }))!.status
    ).toBe(429)
  })
  it('bounds streaming JSON and strict pagination', async () => {
    const oversized = req('/api/admin/newsletter/campaigns', 'POST', { blob: 'x'.repeat(262145) })
    expect((await handleNewsletterEditorialHttp(oversized, w.deps))!.status).toBe(413)
    expect((await handleNewsletterEditorialHttp(req('/api/admin/newsletter?cursor=bad'), w.deps))!.status).toBe(400)
  })
  it('preview/test cannot use a real sender binding', async () => {
    const id = await w.campaign(false)
    let calls = 0
    w.deps.previewSenderFactory = () => ({
      kind: 'cloudflare-email',
      send: async () => {
        calls++
        return { messageId: 'forbidden' }
      }
    })
    expect(
      (await handleNewsletterEditorialHttp(req(`/api/admin/newsletter/campaigns/${id}/test`, 'POST', {}), w.deps))!
        .status
    ).toBe(501)
    expect(calls).toBe(0)
    const preview = await handleNewsletterEditorialHttp(req(`/api/admin/newsletter/campaigns/${id}/preview`), w.deps)
    expect(preview!.status).toBe(200)
  })
  it('anonymous onboarding needs genuine current DOI proof, never implied consent', async () => {
    const requested = await requestNewsletterConsent(
        w.database,
        {
          email: 'new-anonymous@example.invalid',
          purpose: 'newsletter',
          consentText: NEWSLETTER_CONSENT_TEXT,
          consentVersion: NEWSLETTER_POLICY_VERSION,
          consentSource: 'footer',
          idempotencyKey: testUuid(),
          now: Math.floor(Date.parse(w.getNow()) / 1000)
        },
        w.secrets
      ),
      confirmationToken = requested.internalDelivery!.confirmationToken
    const exchange = () =>
      handleNewsletterEditorialHttp(
        req('/api/newsletter/preferences/access', 'POST', { confirmationToken }, { Cookie: '' }),
        w.deps
      )
    expect((await exchange())!.status).toBe(401)
    await confirmNewsletterConsent(w.database, confirmationToken, w.secrets, Math.floor(Date.parse(w.getNow()) / 1000))
    const granted = await exchange()
    expect(granted!.status).toBe(200)
    const value = await granted!.json()
    expect(value).toMatchObject({ source: 'cloudflare', expiresInSeconds: 1800 })
    expect(typeof value.token).toBe('string')
    const pref = await handleNewsletterEditorialHttp(
      req('/api/newsletter/preferences', 'GET', undefined, { Cookie: '', Authorization: `Bearer ${value.token}` }),
      w.deps
    )
    expect(pref!.status).toBe(200)
    expect(await pref!.json()).toMatchObject({ preference: null, revision: 0, canSave: true })
    const sub = w.sqlite
      .prepare('SELECT id FROM newsletter_subscriptions WHERE email_normalized=?')
      .get('new-anonymous@example.invalid')!
    const id = String(sub.id),
      unsubscribe = await createNewsletterUnsubscribeToken(id, w.secrets)
    expect(
      (await handleNewsletterEditorialHttp(
        req('/api/newsletter/preferences/access', 'POST', { confirmationToken: unsubscribe }, { Cookie: '' }),
        w.deps
      ))!.status
    ).toBe(401)
    w.setNow(new Date(Date.parse(w.getNow()) + 48 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    expect((await exchange())!.status).toBe(401)
  })
  it('suppression prevents DOI access exchange without creating consent or preference records', async () => {
    const at = Math.floor(Date.parse(w.getNow()) / 1000),
      email = 'suppressed-doi@example.invalid',
      requested = await requestNewsletterConsent(
        w.database,
        {
          email,
          purpose: 'newsletter',
          consentText: NEWSLETTER_CONSENT_TEXT,
          consentVersion: NEWSLETTER_POLICY_VERSION,
          consentSource: 'footer',
          idempotencyKey: testUuid(),
          now: at
        },
        w.secrets
      )
    await confirmNewsletterConsent(w.database, requested.internalDelivery!.confirmationToken, w.secrets, at)
    await suppressNewsletterEmail(w.database, email, 'complaint', 'synthetic_feedback', w.secrets, at)
    const response = await handleNewsletterEditorialHttp(
      req(
        '/api/newsletter/preferences/access',
        'POST',
        { confirmationToken: requested.internalDelivery!.confirmationToken },
        { Cookie: '' }
      ),
      w.deps
    )
    expect(response!.status).toBe(401)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_access').get()).toEqual({ n: 0 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_preferences').get()).toEqual({ n: 0 })
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'suppressed' })
  })
})
