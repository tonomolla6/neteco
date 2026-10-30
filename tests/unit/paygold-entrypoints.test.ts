import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
const origin = 'https://account.example.test'
function env(enabled: boolean) {
  return {
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-cookie-password-more-than-32-chars',
    DB: { prepare: vi.fn() },
    PAYGOLD_ENABLED: enabled ? 'true' : 'false',
    PAYGOLD_PROVIDER_ORIGIN: 'https://paygold.example.test',
    PAYGOLD_SERVICE: { fetch: vi.fn() },
    REDSYS_ENABLED: 'true',
    REDSYS_ENVIRONMENT: 'sandbox',
    REDSYS_SECRET_KEY: 'synthetic-secret',
    REDSYS_MERCHANT_CODE: '999008881',
    REDSYS_TERMINAL: '1',
    PAYMENT_PUBLIC_BASE_URL: origin
  } as unknown as CloudflareEnv
}
it('owns disabled PayGold endpoint with a private unavailable response', async () => {
  const response = await worker.fetch(
    new Request(`${origin}/api/account/paygold-links`, { method: 'POST' }),
    env(false)
  )
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toContain('private')
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
})
it('rejects methods before checking credentials when enabled', async () => {
  const response = await worker.fetch(new Request(`${origin}/api/account/paygold-links`), env(true))
  expect(response.status).toBe(405)
  expect(response.headers.get('allow')).toBe('POST')
})
it('does not delegate malformed child routes', async () => {
  const response = await worker.fetch(new Request(`${origin}/api/account/paygold-links/other`), env(true))
  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toContain('private')
})
