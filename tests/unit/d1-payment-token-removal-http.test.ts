import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handlePaymentTokenRemovalHttp } from '../../workers/payments/token-removal-http'
const origin = 'https://account.example.invalid'
const config = { password: 'synthetic-cookie-password-is-over-32-bytes', maxAgeSeconds: 3600 }
const tokenId = '40000000-0000-4000-8000-000000000022',
  key = '50000000-0000-4000-8000-000000000022'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  f.sqlite
    .prepare(
      `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at)
    VALUES(?,?,?,'active',1,'v1',?,?,?)`
    )
    .run(tokenId, CUSTOMER, 'provider-private-reference', utc(), utc(), utc())
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({ database: f.database, origin, sessionCookieConfiguration: config, now: () => utc() })
const req = (method = 'GET', body: unknown = { tokenId, expectedVersion: 1, commandId: key }) =>
  new Request(`${origin}/api/account/payment-tokens`, {
    method,
    headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': key },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  })
it('reads owner metadata and accepts idempotent removal through real session cookie', async () => {
  const list = await handlePaymentTokenRemovalHttp(req(), deps())
  expect(list?.status).toBe(200)
  expect(JSON.stringify(await list!.json())).not.toContain('provider-private-reference')
  const result = await handlePaymentTokenRemovalHttp(req('POST'), deps())
  expect(result?.status).toBe(202)
  expect(await result!.json()).toMatchObject({ tokenId, outcome: 'removal_pending' })
  expect((await handlePaymentTokenRemovalHttp(req('POST'), deps()))?.status).toBe(202)
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin for writes', async (mode) => {
  const request = req('POST')
  if (mode === 'missing') request.headers.delete('origin')
  if (mode === 'foreign') request.headers.set('origin', 'https://other.invalid')
  if (mode === 'crosssite') request.headers.set('sec-fetch-site', 'cross-site')
  expect((await handlePaymentTokenRemovalHttp(request, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_commands').get()).toMatchObject({ n: 0 })
})
it('rejects missing cookie, invalid origin configuration, method and query', async () => {
  const anonymous = req()
  anonymous.headers.delete('cookie')
  expect((await handlePaymentTokenRemovalHttp(anonymous, deps()))?.status).toBe(401)
  expect(
    (await handlePaymentTokenRemovalHttp(req(), { ...deps(), origin: 'http://account.example.invalid' }))?.status
  ).toBe(503)
  expect((await handlePaymentTokenRemovalHttp(req('DELETE'), deps()))?.status).toBe(405)
  expect(
    (
      await handlePaymentTokenRemovalHttp(
        new Request(`${origin}/api/account/payment-tokens?x=1`, { headers: { cookie } }),
        deps()
      )
    )?.status
  ).toBe(400)
})
it('rejects malformed and oversized bodies and a mismatched command header', async () => {
  const wrong = req('POST')
  wrong.headers.set('content-type', 'text/plain')
  expect((await handlePaymentTokenRemovalHttp(wrong, deps()))?.status).toBe(415)
  expect(
    (
      await handlePaymentTokenRemovalHttp(
        req('POST', { tokenId, commandId: key, expectedVersion: 1, extra: 'x'.repeat(5000) }),
        deps()
      )
    )?.status
  ).toBe(413)
  const mismatch = req('POST')
  mismatch.headers.set('idempotency-key', tokenId)
  expect((await handlePaymentTokenRemovalHttp(mismatch, deps()))?.status).toBe(400)
  expect(
    (await handlePaymentTokenRemovalHttp(req('POST', { tokenId, commandId: key, expectedVersion: 0 }), deps()))?.status
  ).toBe(400)
})
it('returns null for unrelated paths', async () => {
  expect(await handlePaymentTokenRemovalHttp(new Request(`${origin}/api/account/other`), deps())).toBeNull()
})
it('rechecks live authority after quota before returning the token list', async () => {
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    const stmt = prepare(sql)
    if (sql.includes('INSERT INTO identity_rate_limits')) {
      const first = stmt.first.bind(stmt)
      stmt.first = async (...args: Parameters<typeof first>) => {
        const result = await first(...args)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
        return result
      }
    }
    return stmt
  }
  expect((await handlePaymentTokenRemovalHttp(req(), deps()))?.status).toBe(401)
})
