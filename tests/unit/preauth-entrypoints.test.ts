import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://admin.example.invalid'
const env = (extra: Record<string, unknown> = {}) =>
  ({
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-cookie-password-over-32-characters',
    DB: { prepare: vi.fn() },
    ...extra
  }) as unknown as CloudflareEnv

it('keeps the pre-authorisation admin API unreachable while the feature is off', async () => {
  for (const path of [
    '/api/admin/payments/preauthorizations',
    '/api/admin/payments/%70reauthorizations/x',
    '/api/admin/payments/preauthorizations/'
  ]) {
    const res = await worker.fetch(new Request(`${origin}${path}`), env())
    expect([503, 404]).toContain(res.status)
    expect(res.headers.get('cache-control')).toContain('no-store')
  }
  const res = await worker.fetch(new Request(`${origin}/api/admin/payments/preauthorizations`), env())
  expect(res.status).toBe(503)
})
it('owns the bank notification path and refuses it when the feature is off', async () => {
  const res = await worker.fetch(
    new Request(`${origin}/api/payments/redsys/preauth-notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b'
    }),
    env()
  )
  expect(res.status).toBe(503)
})
it('does not treat the ordinary notification route as a pre-authorisation', async () => {
  const res = await worker.fetch(new Request(`${origin}/api/payments/redsys/notification`, { method: 'GET' }), env())
  expect(res.status).toBe(405)
})
it('rejects an unauthenticated admin call even when enabled in configuration', async () => {
  const res = await worker.fetch(
    new Request(`${origin}/api/admin/payments/preauthorizations?orderId=${crypto.randomUUID()}`),
    env({ PAYMENT_PREAUTH_ENABLED: 'true' })
  )
  expect([401, 503]).toContain(res.status)
})
