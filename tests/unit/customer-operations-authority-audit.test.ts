import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { handleCustomerOperationsHttp } from '../../workers/runtime/customer-operations-http'
import {
  configuredNewsletterEditorial,
  type CustomerOperationsEnv
} from '../../workers/runtime/customer-operations-config'
import { dispatchConfiguredNewsletterCampaigns } from '../../workers/runtime/customer-operations-dispatch'
import { cmsRuntimeDependencies } from '../../workers/runtime/operations-config'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { readCmsPublicPage } from '../../workers/cms/public-http'
import { validateEditorialLinks } from '../../workers/marketing/newsletter-campaign-render'
import {
  suppressNewsletterEmail,
  requestNewsletterConsent,
  confirmNewsletterConsent
} from '../../workers/marketing/newsletter'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import { transportReady, resolveEditorialSender } from '../../workers/marketing/newsletter-campaign-transport'
import { environment } from '../support/customer-operations-fixture'
import { newsletterEditorialFixture, newsletterCampaignDocument } from './d1-newsletter-editorial-fixture'
import { cmsDocument } from './d1-cms-fixture'
import { testUuid, testNow } from '../support/deterministic'

type World = Awaited<ReturnType<typeof newsletterEditorialFixture>>
const opened: World[] = []
afterEach(() => {
  for (const world of opened.splice(0)) world.sqlite.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function world() {
  const fixture = await newsletterEditorialFixture()
  fixture.deps.publicOrigin = 'https://editorial.example.org'
  opened.push(fixture)
  return fixture
}
function runtime(w: World, overrides: Record<string, unknown> = {}): CustomerOperationsEnv {
  return environment({
    APP_ENV: 'production',
    DB: w.database,
    AUTH_ORIGIN: w.deps.publicOrigin,
    AUTH_ENABLED: 'true',
    NUXT_SESSION_PASSWORD: w.deps.session!.password,
    AUTH_RATE_LIMIT_PEPPER: w.deps.rateLimitPepper,
    NEWSLETTER_PUBLIC_ORIGIN: w.deps.publicOrigin,
    NEWSLETTER_EMAIL_FROM: 'newsletter@example.org',
    NEWSLETTER_HMAC_KEY: Buffer.from(w.secrets.hmacKey).toString('base64url'),
    NEWSLETTER_EDITORIAL_ENABLED: 'true',
    NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
    ...overrides
  })
}
function request(w: World, path: string, method = 'GET', body?: string, cookie = '') {
  return new Request(w.deps.publicOrigin + path, {
    method,
    headers: {
      origin: w.deps.publicOrigin,
      'cf-connecting-ip': '192.0.2.50',
      cookie,
      'content-type': 'application/json',
      'idempotency-key': testUuid()
    },
    ...(body === undefined ? {} : { body })
  })
}
async function approved(w: World) {
  await w.subscriber()
  await w.policy()
  return w.campaign()
}

describe('independent customer-operation authority audit with real SQLite', () => {
  it('keeps the fixture clock frozen and permits an explicit temporal advance', async () => {
    const w = await world(),
      initial = Date.parse(w.getNow())
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(initial + 2000)
    expect(Date.parse(w.getNow())).toBe(initial)
    const frozen = new Date(initial + 2000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    w.setNow(frozen)
    vi.setSystemTime(initial + 5000)
    expect(w.getNow()).toBe(frozen)
    expect(w.deps.now?.()).toBe(frozen)
  })
  it.each(['revoked', 'mfa', 'permission'])(
    'mounted root newsletter rejects live %s loss before consuming a command',
    async (kind) => {
      const w = await world(),
        cookie = (await issueD1SessionCookie(w.database, w.claims, w.deps.session!))!.split(';')[0]!
      if (kind === 'revoked')
        w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(w.claims.sessionId)
      if (kind === 'mfa') w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(w.claims.sessionId)
      if (kind === 'permission')
        w.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
      const incoming = request(w, '/api/admin/newsletter/campaigns', 'POST', 'private-unparsed-command', cookie),
        response = await worker.fetch(incoming, runtime(w))
      expect(response.status).toBe(kind === 'revoked' ? 401 : 403)
      expect(incoming.bodyUsed).toBe(false)
      expect(await response.text()).not.toContain('private-unparsed-command')
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_commands').get()).toEqual({ n: 0 })
    }
  )

  it('configured dispatch quarantines an ambiguous acknowledgement and never retries its provider', async () => {
    const w = await world()
    await approved(w)
    const send = vi.fn(async () => {
        throw new Error('synthetic-unknown-provider-result-with-private-data')
      }),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden')),
      env = runtime(w, { NEWSLETTER_EMAIL: { send } })
    expect(await dispatchConfiguredNewsletterCampaigns(env)).toMatchObject({ manualReview: 1, acceptedProvider: 0 })
    expect(w.sqlite.prepare('SELECT status,last_error_code FROM newsletter_editorial_deliveries').get()).toEqual({
      status: 'manual_review',
      last_error_code: 'provider_outcome_unknown'
    })
    await dispatchConfiguredNewsletterCampaigns(env)
    expect(send).toHaveBeenCalledTimes(1)
    expect(outbound).not.toHaveBeenCalled()
  })

  it('configured dispatch rechecks genuine suppression after its sender is selected', async () => {
    const w = await world()
    await approved(w)
    const send = vi.fn(async () => ({ messageId: 'synthetic-never-called' })),
      env = runtime(w)
    Object.defineProperty(env, 'NEWSLETTER_EMAIL', {
      get: () => {
        w.sqlite.exec(`INSERT OR IGNORE INTO newsletter_suppressions(email_hash,reason,source,created_at,updated_at)
          SELECT email_hash,'complaint','synthetic-authenticated-feedback',unixepoch(),unixepoch() FROM newsletter_subscriptions`)
        return { send }
      }
    })
    expect(await dispatchConfiguredNewsletterCampaigns(env)).toMatchObject({ acceptedProvider: 0, expanded: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 1 })
  })

  it.each([false, true])(
    'runtime real transport never infers preferences from a subscription (DOI=%s)',
    async (confirmed) => {
      const w = await world(),
        consent = await requestNewsletterConsent(
          w.database,
          {
            email: 'explicit-consent-without-preferences@example.invalid',
            purpose: 'newsletter',
            consentText: NEWSLETTER_CONSENT_TEXT,
            consentVersion: NEWSLETTER_POLICY_VERSION,
            consentSource: 'footer',
            idempotencyKey: testUuid()
          },
          w.secrets
        )
      expect(consent.internalDelivery).not.toBeNull()
      if (confirmed) await confirmNewsletterConsent(w.database, consent.internalDelivery!.confirmationToken, w.secrets)
      await w.policy()
      await w.campaign()
      const send = vi.fn(async () => ({ messageId: 'synthetic-never-called' }))
      expect(await dispatchConfiguredNewsletterCampaigns(runtime(w, { NEWSLETTER_EMAIL: { send } }))).toMatchObject({
        expanded: 0,
        acceptedProvider: 0
      })
      expect(send).not.toHaveBeenCalled()
      expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({
        status: confirmed ? 'confirmed' : 'pending'
      })
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_preferences').get()).toEqual({ n: 0 })
    }
  )

  it('root preference API cannot restore a suppressed subscription or manufacture access from a random DOI token', async () => {
    const w = await world(),
      subscriber = await w.subscriber()
    await suppressNewsletterEmail(w.database, 'cms@example.invalid', 'complaint', 'synthetic-audit', w.secrets)
    const incoming = request(
        w,
        '/api/newsletter/preferences/access',
        'POST',
        JSON.stringify({
          confirmationToken: `n1.${testUuid()}.${'0'.repeat(64)}`
        })
      ),
      response = await handleCustomerOperationsHttp(incoming, runtime(w))
    expect(response!.status).toBe(401)
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions WHERE id=?').get(subscriber.id)).toEqual({
      status: 'suppressed'
    })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_editorial_access').get()).toEqual({ n: 1 })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 1 })
  })

  it('an OFF namespace never invokes trap-backed sender, SQL or attachment I/O', async () => {
    const env = environment(),
      observed = vi.fn(() => {
        throw new Error('private-binding-access-forbidden')
      })
    Object.defineProperty(env, 'NEWSLETTER_EMAIL', { get: observed })
    for (const path of ['/api/admin/newsletter', '/api/admin/support', '/api/admin/refunds/requests']) {
      const incoming = new Request('https://neteco.invalid' + path),
        response = await handleCustomerOperationsHttp(incoming, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBeGreaterThanOrEqual(500)
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
    expect(observed).not.toHaveBeenCalled()
    expect(env.MEDIA.get).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(env.MEDIA.head).not.toHaveBeenCalled()
  })

  it('an actually emitted opt-out works with acquisition and delivery OFF, remains irreversible and cannot be forged', async () => {
    const w = await world()
    await approved(w)
    const send = vi.fn(async (_message: { headers?: Record<string, string>; text: string }) => ({
        messageId: 'synthetic-accepted-with-unsubscribe'
      })),
      env = runtime(w, { NEWSLETTER_EMAIL: { send } })
    expect(await dispatchConfiguredNewsletterCampaigns(env)).toMatchObject({ acceptedProvider: 1 })
    const emitted = send.mock.calls[0]![0],
      link = emitted.headers!['List-Unsubscribe']!,
      token = new URL(link.slice(1, -1)).searchParams.get('token')!,
      preferences = /^Preferencias: (\S+)$/m.exec(emitted.text)![1]!,
      bearer = new URL(preferences).searchParams.get('token')!,
      maintenance = {
        ...env,
        NEWSLETTER_ENABLED: 'false',
        NEWSLETTER_EDITORIAL_ENABLED: 'false',
        NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false',
        NEWSLETTER_EMAIL: undefined
      }
    const invalid = await worker.fetch(
      request(
        w,
        '/api/newsletter/unsubscribe',
        'POST',
        JSON.stringify({ token: `u1.${testUuid()}.${'0'.repeat(64)}` })
      ),
      maintenance
    )
    expect(invalid.status).toBe(200)
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'confirmed' })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 0 })
    const response = await worker.fetch(
      request(w, '/api/newsletter/unsubscribe', 'POST', JSON.stringify({ token })),
      maintenance
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'unsubscribed' })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 1 })
    expect(
      (await worker.fetch(request(w, '/api/newsletter/unsubscribe', 'POST', JSON.stringify({ token })), maintenance))
        .status
    ).toBe(200)
    // Turn authoring back on, never acquisition: an earlier purpose-bound
    // preferences proof still cannot remove the irreversible suppression.
    const save = new Request(w.deps.publicOrigin + '/api/newsletter/preferences', {
      method: 'PUT',
      headers: {
        origin: w.deps.publicOrigin,
        'cf-connecting-ip': '192.0.2.50',
        'content-type': 'application/json',
        'idempotency-key': testUuid(),
        authorization: 'Bearer ' + bearer
      },
      body: JSON.stringify({
        action: 'save',
        expectedRevision: 1,
        preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
      })
    })
    expect((await worker.fetch(save, { ...maintenance, NEWSLETTER_EDITORIAL_ENABLED: 'true' })).status).toBe(409)
    expect(w.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'unsubscribed' })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM newsletter_suppressions').get()).toEqual({ n: 1 })
    expect(w.sqlite.prepare('SELECT revision FROM newsletter_editorial_preferences').get()).toEqual({ revision: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('configured cron sends only genuinely live CMS links (withdrawn=%s)', async (withdrawn) => {
    const w = await world(),
      env = runtime(w, { CMS_PUBLICATION_ENABLED: 'true' }),
      cms = { ...cmsRuntimeDependencies(env), now: w.deps.now }
    // Reproduce crossing a wall-clock second between fixture creation and CMS
    // publication without a sleep. CMS authoring and newsletter authoring share
    // the fixture's explicit clock; configured cron still uses the live clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 2000)
    const created = await executeD1CmsDraftCommand(
      w.database,
      w.claims,
      'create_draft',
      {},
      { ...cmsDocument(), expectedVersion: 0 },
      { idempotencyKey: testUuid(), now: w.getNow() }
    )
    await executeCmsPublicationCommand(
      cms,
      w.claims,
      created.pageId,
      {
        action: 'publish',
        expectedRevision: 0,
        expectedVersion: 1,
        versionId: created.versionId,
        reason: 'Synthetic authority audit publication'
      },
      testUuid()
    )
    w.deps.cmsPublication = cms
    await w.subscriber()
    await w.policy()
    const document = newsletterCampaignDocument()
    document.blocks.push({
      id: testUuid(),
      type: 'link',
      kind: 'editorial',
      label: 'Contenido CMS vigente',
      target: { type: 'cms', slug: 'guia-editorial' }
    })
    const campaign = await w.campaign(true, document),
      send = vi.fn(async () => ({ messageId: 'synthetic-cms-link-receipt' }))
    env.NEWSLETTER_EMAIL = { send }
    expect((await readCmsPublicPage(cms, 'guia-editorial')).title).toBe('Guía editorial')
    await expect(
      readCmsPublicPage(
        { ...cms, now: () => new Date(Date.parse(w.getNow()) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
        'guia-editorial'
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      validateEditorialLinks({ ...configuredNewsletterEditorial(env), cmsPublication: cms }, document)
    ).resolves.toBeUndefined()
    if (withdrawn) {
      await executeCmsPublicationCommand(
        cms,
        w.claims,
        created.pageId,
        {
          action: 'withdraw',
          expectedRevision: 1,
          expectedVersion: 1,
          reason: 'Explicit audit withdrawal before delivery'
        },
        testUuid()
      )
      await expect(readCmsPublicPage(cms, 'guia-editorial')).rejects.toMatchObject({ code: 'not_found' })
    }
    const batchErrors: string[] = [],
      realBatch = w.database.batch.bind(w.database)
    vi.spyOn(w.database, 'batch').mockImplementation(async (statements) => {
      try {
        return await realBatch(statements)
      } catch (failure) {
        batchErrors.push(failure instanceof Error ? failure.message : 'unknown_database_error')
        throw failure
      }
    })
    expect({ report: await dispatchConfiguredNewsletterCampaigns(env), batchErrors }).toMatchObject({
      report: {
        expanded: 1,
        skipped: withdrawn ? 1 : 0,
        acceptedProvider: withdrawn ? 0 : 1
      },
      batchErrors: []
    })
    expect(w.sqlite.prepare('SELECT status,last_error_code FROM newsletter_editorial_deliveries').get()).toEqual({
      status: withdrawn ? 'skipped' : 'accepted',
      last_error_code: withdrawn ? 'source_unavailable' : null
    })
    expect(w.sqlite.prepare('SELECT status FROM newsletter_editorial_campaigns WHERE id=?').get(campaign)).toEqual({
      status: 'completed'
    })
    expect(send).toHaveBeenCalledTimes(withdrawn ? 0 : 1)
  })

  it('never asserts real delivery availability without a dedicated sender binding', () => {
    const env = environment({
        APP_ENV: 'production',
        NEWSLETTER_EDITORIAL_ENABLED: 'true',
        NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
        NEWSLETTER_EMAIL_FROM: 'newsletter@example.org',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://editorial.example.org',
        NEWSLETTER_HMAC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        NEWSLETTER_EMAIL: undefined
      }),
      deps = configuredNewsletterEditorial(env)
    expect(transportReady(deps.transport, deps.publicOrigin)).toBe(false)
    expect(() => resolveEditorialSender(deps.transport!, deps.publicOrigin)).toThrow('delivery_disabled')
  })

  it.each([
    { NEWSLETTER_HMAC_KEY: undefined },
    { NEWSLETTER_HMAC_KEY: 'A'.repeat(43) },
    { NEWSLETTER_PUBLIC_ORIGIN: 'https://editorial.example.org/path' }
  ])('does not enable or select a sender without genuine opt-out authority %#', async (invalid) => {
    const access = vi.fn(() => {
        throw new Error('sender_access_forbidden')
      }),
      env = environment({
        APP_ENV: 'production',
        NEWSLETTER_EDITORIAL_ENABLED: 'true',
        NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
        NEWSLETTER_EMAIL_FROM: 'newsletter@example.org',
        NEWSLETTER_PUBLIC_ORIGIN: 'https://editorial.example.org',
        NEWSLETTER_HMAC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        ...invalid
      })
    Object.defineProperty(env, 'NEWSLETTER_EMAIL', { get: access })
    const deps = configuredNewsletterEditorial(env)
    expect(deps.transport?.mode).toBe('disabled')
    expect(transportReady(deps.transport, deps.publicOrigin)).toBe(false)
    expect(await dispatchConfiguredNewsletterCampaigns(env)).toEqual({ disabled: true })
    expect(access).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
})
