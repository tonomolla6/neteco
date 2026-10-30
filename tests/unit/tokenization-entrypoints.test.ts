import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://account.example.invalid'
const env = (enabled = true) =>
  ({
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-cookie-password-over-32-characters',
    DB: { prepare: vi.fn() }
  }) as unknown as CloudflareEnv

it('owns the saved-card namespace even when authentication is disabled', async () => {
  const res = await worker.fetch(new Request(`${origin}/api/account/saved-cards/availability`), env(false))
  expect(res.status).toBe(503)
  expect(res.headers.get('cache-control')).toContain('private')
})
it('does not route child paths to a legacy handler', async () => {
  const res = await worker.fetch(new Request(`${origin}/api/account/saved-cards/other`), env())
  expect(res.status).toBe(404)
  expect(res.headers.get('cache-control')).toContain('private')
})
it('rejects an unauthenticated one-click call and leaves the gate closed by default', async () => {
  const res = await worker.fetch(
    new Request(`${origin}/api/account/saved-cards/one-click`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{}'
    }),
    env()
  )
  expect(res.status).toBe(401)
})
