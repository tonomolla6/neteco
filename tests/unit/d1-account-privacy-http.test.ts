import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAccountPrivacyHttp } from '../../workers/auth/account-privacy-http'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
const origin = 'https://privacy.neteco.test',
  configuration = { password: 'synthetic-privacy-cookie-password-longer32', maxAgeSeconds: 3600 },
  key = '11111111-1111-4111-8111-111111111165'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0065_account_privacy.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0070_delivery_preferences.sql', 'utf8'))
  await f.database.batch(
    splitDemoSql(await readFile('db/d1/migrations/0071_account_security_notices.sql', 'utf8')).map((sql) =>
      f.database.prepare(sql)
    )
  )
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({ database: f.database, origin, sessionCookieConfiguration: configuration, now: () => utc() })
const request = (method = 'GET', suffix = '', body: unknown = { requestType: 'export', idempotencyKey: key }) =>
  new Request(`${origin}/api/account/privacy${suffix}`, {
    method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  })
it('uses real cookie authority and returns private attachment only for its export', async () => {
  const created = await handleAccountPrivacyHttp(request('POST'), deps())
  expect(created?.status).toBe(202)
  const receipt = (await created!.json()) as { id: string }
  expect((await handleAccountPrivacyHttp(request('POST'), deps()))?.status).toBe(202)
  const download = await handleAccountPrivacyHttp(request('GET', `/${receipt.id}/download`), deps())
  expect(download?.status).toBe(200)
  expect(download?.headers.get('content-disposition')).toBe(`attachment; filename="neteco-datos-${receipt.id}.json"`)
  expect(download?.headers.get('cache-control')).toBe('private, no-store')
  expect(await download!.json()).toMatchObject({ profile: { email: 'buyer@example.invalid' }, securityNotices: [] })
  expect(await (await handleAccountPrivacyHttp(request('GET', `/commands/${key}`), deps()))!.json()).toMatchObject({
    outcome: 'applied',
    receipt
  })
})
it.each(['missing', 'foreign', 'crosssite'])('blocks %s CSRF before writes', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleAccountPrivacyHttp(req, deps()))?.status).toBe(403)
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 0 })
})
it.each(['?extra=x', '?id=x', '/commands/bad', '/bad/download'])(
  'fails closed for malformed route %s',
  async (suffix) => {
    expect((await handleAccountPrivacyHttp(request('GET', suffix), deps()))?.status).toBe(
      suffix.includes('download') ? 404 : 400
    )
  }
)
it('rejects anonymous, wrong deployment origin and mismatched key/body', async () => {
  const anonymous = request()
  anonymous.headers.delete('cookie')
  expect((await handleAccountPrivacyHttp(anonymous, deps()))?.status).toBe(401)
  expect((await handleAccountPrivacyHttp(request(), { ...deps(), origin: 'http://privacy.neteco.test' }))?.status).toBe(
    503
  )
  const req = request('POST')
  req.headers.set('Idempotency-Key', '22222222-2222-4222-8222-222222222265')
  expect((await handleAccountPrivacyHttp(req, deps()))?.status).toBe(400)
})
it('enforces content and streaming bounds and durable owner quota', async () => {
  const wrong = request('POST')
  wrong.headers.set('Content-Type', 'text/plain')
  expect((await handleAccountPrivacyHttp(wrong, deps()))?.status).toBe(415)
  expect(
    (
      await handleAccountPrivacyHttp(
        request('POST', '', { requestType: 'export', idempotencyKey: key, extra: 'x'.repeat(9000) }),
        deps()
      )
    )?.status
  ).toBe(413)
  f.sqlite
    .prepare(
      "INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at) VALUES(?,'account-privacy-requests',10,?,?) ON CONFLICT(identity_id,scope) DO UPDATE SET used=10"
    )
    .run(BUYER_CLAIMS.identityId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600)
  expect((await handleAccountPrivacyHttp(request('POST'), deps()))?.status).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 0 })
})
