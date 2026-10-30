import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { executeHighValueConsent } from '../../workers/communications/high-value-consent'
import { handleWhatsAppBusinessHttp } from '../../workers/communications/whatsapp-business-http'
const origin = 'https://whatsapp.neteco.test',
  config = { password: 'synthetic-whatsapp-cookie-password-over-32', maxAgeSeconds: 3600 }
const first = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222',
  third = '33333333-3333-4333-8333-333333333333'
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
const options = () => ({
  now: () => utc(),
  transport: 'official-fake',
  pricing: { whatsappCostMinor: 7, dailyBudgetMinor: 20 }
})
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'password_changed',?)"
    )
    .run('44444444-4444-4444-8444-444444444444', BUYER_CLAIMS.identityId, utc())
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: config,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-whatsapp-pepper-more-than-32',
  ...options()
})
const request = (
  path = 'state',
  body: unknown = { action: 'inbound', expectedVersion: 0 },
  id = second,
  method = 'POST'
) =>
  new Request(`${origin}/api/admin/customers/${CUSTOMER}/whatsapp-business/${path}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': id,
      'CF-Connecting-IP': '192.0.2.8'
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  })
it('records simulated inbound and sends only with opt-in', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    first,
    { channel: 'whatsapp', expectedVersion: 0, action: 'grant', proof: 'case-whatsapp-123' },
    options()
  )
  expect((await handleWhatsAppBusinessHttp(request(), deps()))?.status).toBe(200)
  const res = await handleWhatsAppBusinessHttp(
    request(
      'messages',
      { eventId: '44444444-4444-4444-8444-444444444444', event: 'security_alert', consentVersion: 1, stateVersion: 1 },
      third
    ),
    deps()
  )
  expect(res?.status).toBe(200)
  expect(await res!.json()).toMatchObject({ status: 'simulated', mode: 'session' })
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin', async (mode) => {
  const r = request()
  if (mode === 'missing') r.headers.delete('origin')
  if (mode === 'foreign') r.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') r.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleWhatsAppBusinessHttp(r, deps()))?.status).toBe(403)
})
it('denies customer sessions and unsupported methods', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  expect((await handleWhatsAppBusinessHttp(request(), deps()))?.status).toBe(403)
  expect((await handleWhatsAppBusinessHttp(request('state', {}, second, 'GET'), deps()))?.status).toBe(405)
})
it('rejects oversized and untrusted state fields', async () => {
  expect(
    (
      await handleWhatsAppBusinessHttp(
        request('state', { action: 'inbound', expectedVersion: 0, occurredAt: '2030-01-01T00:00:00Z' }),
        deps()
      )
    )?.status
  ).toBe(400)
  expect((await handleWhatsAppBusinessHttp(request('state', { x: 'x'.repeat(9000) }), deps()))?.status).toBe(413)
})
it('disables simulation when no official fake adapter is configured', async () => {
  expect((await handleWhatsAppBusinessHttp(request(), { ...deps(), transport: 'disabled' }))?.status).toBe(503)
})
it('reads the simulated state privately without a command', async () => {
  const res = await handleWhatsAppBusinessHttp(request('status', {}, second, 'GET'), deps())
  expect(res?.status).toBe(200)
  expect(res?.headers.get('cache-control')).toContain('private')
  expect(await res!.json()).toMatchObject({ version: 0, handoff: false, templates: [] })
})
it('rejects simulated delivery for an event unrelated to the customer', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    first,
    { channel: 'whatsapp', expectedVersion: 0, action: 'grant', proof: 'case-whatsapp-123' },
    options()
  )
  await handleWhatsAppBusinessHttp(request(), deps())
  const res = await handleWhatsAppBusinessHttp(
    request(
      'messages',
      { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event: 'security_alert', consentVersion: 1, stateVersion: 1 },
      third
    ),
    deps()
  )
  expect(res?.status).toBe(404)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 0 })
})
it('rejects simulated delivery when event ownership changes before the atomic write', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    first,
    { channel: 'whatsapp', expectedVersion: 0, action: 'grant', proof: 'case-whatsapp-123' },
    options()
  )
  await handleWhatsAppBusinessHttp(request(), deps())
  const batch = f.database.batch.bind(f.database)
  let pending = true
  f.database.batch = async (statements) => {
    if (pending) {
      pending = false
      f.sqlite.prepare('UPDATE identities SET customer_id=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    }
    return batch(statements)
  }
  const res = await handleWhatsAppBusinessHttp(
    request(
      'messages',
      { eventId: '44444444-4444-4444-8444-444444444444', event: 'security_alert', consentVersion: 1, stateVersion: 1 },
      third
    ),
    deps()
  )
  expect(res?.status).toBe(404)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 0 })
})
it('limits automatic WhatsApp simulations per customer across different high-value events', async () => {
  const event2 = '55555555-5555-4555-8555-555555555555'
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'session_revoked',?)"
    )
    .run(event2, BUYER_CLAIMS.identityId, utc())
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    first,
    { channel: 'whatsapp', expectedVersion: 0, action: 'grant', proof: 'case-whatsapp-123' },
    options()
  )
  await handleWhatsAppBusinessHttp(request(), deps())
  const body = {
    eventId: '44444444-4444-4444-8444-444444444444',
    event: 'security_alert',
    consentVersion: 1,
    stateVersion: 1
  }
  expect((await handleWhatsAppBusinessHttp(request('messages', body, third), deps()))?.status).toBe(200)
  expect(
    (
      await handleWhatsAppBusinessHttp(
        request('messages', { ...body, eventId: event2 }, '66666666-6666-4666-8666-666666666666'),
        deps()
      )
    )?.status
  ).toBe(429)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 1 })
})
