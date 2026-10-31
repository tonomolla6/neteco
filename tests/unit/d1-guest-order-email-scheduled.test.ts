import { afterEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { applyScheduledAuthStageSchema } from '../support/scheduled-auth-stages'

// Observe the real scheduled entrypoint's configuration boundary. The issuer,
// durable delivery and fake-sender behavior have separate database tests.
vi.mock('../../workers/communications/transactional-email-delivery', () => ({
  dispatchTransactionalEmails: vi.fn(async () => ({
    sent: 0,
    retryable: 0,
    manualReview: 0,
    lostLease: 0,
    disabled: true
  }))
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each(['true', 'false'])('only supplies guest-order link authority when authentication is %s', async (auth) => {
  const sqlite = await openMigratedDatabase()
  await applyScheduledAuthStageSchema(sqlite)
  const database = d1OverSqlite(sqlite)
  const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_forbidden'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const provider = vi.fn()
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: auth,
    AUTH_ORIGIN: 'https://shop.example.invalid',
    NUXT_SESSION_PASSWORD: 'synthetic-guest-link-scheduled-password-0123456789',
    DB: database,
    ASYNC_JOBS: { send: vi.fn(async () => undefined) },
    MEDIA: {},
    EMAIL: { send: provider },
    NEWSLETTER_EMAIL: { send: provider },
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    AUTH_EMAIL_ENABLED: 'false',
    NEWSLETTER_ENABLED: 'false'
  } as unknown as CloudflareEnv
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2030-01-02T12:00:00Z') } as ScheduledController, env)
    expect(dispatchTransactionalEmails).toHaveBeenCalledOnce()
    const config = vi.mocked(dispatchTransactionalEmails).mock.calls[0]![2]
    expect(config.enabled).toBe(false)
    if (auth === 'true') {
      expect(config).toHaveProperty('guestOrderLinks', {
        publicOrigin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
      })
    } else {
      expect(config).not.toHaveProperty('guestOrderLinks')
    }
    expect(provider).not.toHaveBeenCalled()
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    sqlite.close()
  }
})
