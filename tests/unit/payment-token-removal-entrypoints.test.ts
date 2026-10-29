import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
const origin = 'https://account.example.invalid'
const env = (enabled: boolean) =>
  ({
    APP_ENV: 'local',
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-cookie-password-over-32-characters',
    DB: { prepare: vi.fn() }
  }) as unknown as CloudflareEnv
it('owns the account payment token endpoint when authentication is disabled', async () => {
  const response = await worker.fetch(new Request(`${origin}/api/account/payment-tokens`), env(false))
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toContain('private')
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
})
it('rejects unsupported methods on the mounted endpoint before database access', async () => {
  const response = await worker.fetch(
    new Request(`${origin}/api/account/payment-tokens`, { method: 'DELETE' }),
    env(true)
  )
  expect(response.status).toBe(405)
  expect(response.headers.get('allow')).toBe('GET, POST')
})
it('does not route malformed child paths to a legacy handler', async () => {
  const response = await worker.fetch(new Request(`${origin}/api/account/payment-tokens/other`), env(true))
  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toContain('private')
})
it('handles a real session and D1 removal through the worker dispatcher', async () => {
  const { readFile } = await import('node:fs/promises')
  const { returnsFixture, BUYER_CLAIMS, CUSTOMER, utc } = await import('./d1-returns-fixture')
  const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
  const fixture = await returnsFixture()
  try {
    fixture.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
    const tokenId = '40000000-0000-4000-8000-000000000022',
      commandId = '50000000-0000-4000-8000-000000000022'
    fixture.sqlite
      .prepare(
        `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`
      )
      .run(tokenId, CUSTOMER, 'private-reference', utc(), utc(), utc())
    const configuration = { password: 'synthetic-cookie-password-over-32-characters', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
    const environment = { ...env(true), DB: fixture.database } as CloudflareEnv
    const response = await worker.fetch(
      new Request(`${origin}/api/account/payment-tokens`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': commandId },
        body: JSON.stringify({ tokenId, commandId, expectedVersion: 1 })
      }),
      environment
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ tokenId, outcome: 'removal_pending' })
    expect(fixture.sqlite.prepare('SELECT status FROM payment_saved_tokens WHERE id=?').get(tokenId)).toMatchObject({
      status: 'removal_pending'
    })
  } finally {
    fixture.sqlite.close()
  }
})
