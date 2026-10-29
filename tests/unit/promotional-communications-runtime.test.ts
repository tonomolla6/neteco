import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { communicationHistoryFixture } from './d1-communication-history-fixture'
import { ORIGIN } from './d1-support-fixture'
import { communicationRetryIntentHash } from '../../shared/communication-history'

describe('actual Worker promotions and communication history routing', () => {
  it.each([
    '/api/admin/communications/history',
    '/api/admin/%63ommunications/history',
    '/API/admin/communications/history'
  ])('owns AUTH-disabled %s privately without legacy fallback or database access', async (path) => {
    const env = environment({ AUTH_ENABLED: 'false', AUTH_ORIGIN: ORIGIN })
    const response = await worker.fetch(new Request(ORIGIN + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('rate limits global history before authentication or database access', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, ADMIN_EDGE_LIMIT: { limit } })
    const response = await worker.fetch(
      new Request(ORIGIN + '/api/admin/communications/history', {
        headers: { 'CF-Connecting-IP': '192.0.2.81' }
      }),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('exposes real empty CMS selection and fails closed while publication is disabled', async () => {
    const f = await cmsPublicationFixture()
    try {
      const env = environment({ DB: f.database, CMS_PUBLICATION_ENABLED: 'true' }) as unknown as CloudflareEnv
      const request = new Request('https://neteco.invalid/api/promotional-content?placement=home&path=%2F')
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toMatchObject({ source: 'cloudflare', placement: 'home', items: [] })
      const disabled = environment({ CMS_PUBLICATION_ENABLED: 'false' })
      const unavailable = await worker.fetch(request, disabled as unknown as CloudflareEnv)
      expect(unavailable.status).toBe(503)
      expect(disabled.DB.prepare).not.toHaveBeenCalled()
    } finally {
      f.sqlite.close()
    }
  })

  it('consumes encoded promotional aliases instead of falling through to Node', async () => {
    const env = environment()
    const response = await worker.fetch(
      new Request('https://neteco.invalid/api/%70romotional-content?placement=home&path=%2F'),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found' } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('lists and rearms preparation only, recovers an exact receipt and denies a revoked replay even with EMAIL OFF', async () => {
    const f = await communicationHistoryFixture()
    try {
      const env = environment({
        DB: f.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: ORIGIN,
        NUXT_SESSION_PASSWORD: f.deps.sessionCookieConfiguration!.password,
        EMAIL_ENABLED: 'false',
        SUPPORT_ENABLED: 'false'
      }) as unknown as CloudflareEnv
      const id = crypto.randomUUID(),
        hash = await communicationRetryIntentHash(f.eventId, f.input)
      const send = (path = '', body?: unknown) =>
        worker.fetch(
          new Request(ORIGIN + '/api/admin/communications/history' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              cookie: f.adminCookie,
              origin: ORIGIN,
              'CF-Connecting-IP': '192.0.2.81',
              'Content-Type': 'application/json',
              'Idempotency-Key': id,
              'X-Neteco-Command-Payload-Hash': hash
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }),
          env
        )
      expect((await send()).status).toBe(200)
      const applied = await send('/' + encodeURIComponent(f.eventId) + '/commands', f.input)
      expect(applied.status).toBe(201)
      const receipt = await applied.json()
      expect(receipt).toMatchObject({ eventId: f.eventId, attempts: 2, senderInvoked: false, attemptsReset: false })
      expect(await (await send('/commands/' + id)).json()).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt
      })
      f.sqlite.exec(
        "DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage'"
      )
      expect((await send('/' + encodeURIComponent(f.eventId) + '/commands', f.input)).status).toBe(403)
      expect(
        f.sqlite.prepare('SELECT attempts,status FROM transactional_email_deliveries WHERE event_id=?').get(f.eventId)
      ).toMatchObject({ attempts: 2, status: 'pending' })
    } finally {
      f.sqlite.close()
    }
  })
})
