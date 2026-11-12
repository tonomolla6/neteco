import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeOneClickProvider, ORIGIN, payExtFixture, redsysConfig, signedEnvelope, utc } from './pay-ext-fixture'
import { BUYER_CLAIMS } from './d1-returns-fixture'
import {
  handleTokenizationHttp,
  ownsSavedCardsNamespace,
  type TokenizationHttpDependencies
} from '../../workers/payments/tokenization-http'
import { captureTokenAfterPayment, ONE_CLICK_CONSENT_VERSION } from '../../workers/payments/tokenization'
import { handlePaymentHttp } from '../../workers/payments/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testUuid } from '../support/deterministic'

const cookieConfig = { password: 'synthetic-saved-card-cookie-password-over-32-chars', maxAgeSeconds: 3600 }
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
let f: Awaited<ReturnType<typeof payExtFixture>>
let provider: ReturnType<typeof fakeOneClickProvider>
beforeEach(async () => {
  f = await payExtFixture()
  provider = fakeOneClickProvider()
})
afterEach(() => f?.sqlite.close())

const tokenization = () => ({
  database: f.database,
  configuration: redsysConfig,
  provider,
  inventory: { assign: f.inventory.assign },
  now: () => utc()
})
const deps = (over: Partial<TokenizationHttpDependencies> = {}): TokenizationHttpDependencies => ({
  tokenization: tokenization(),
  database: f.database,
  origin: ORIGIN,
  sessionCookieConfiguration: cookieConfig,
  ...over
})
async function call(
  path: string,
  init: {
    method?: string
    body?: unknown
    token?: string | null
    headers?: Record<string, string>
    session?: boolean
  } = {},
  d = deps()
) {
  const method = init.method ?? 'POST'
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.session !== false)
    headers.cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, cookieConfig))!.split(';')[0]!
  if (method === 'POST') {
    headers['content-type'] ??= 'application/json'
    headers.origin ??= ORIGIN
  }
  if (init.token) headers.authorization = `Order ${init.token}`
  return handleTokenizationHttp(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    }),
    d
  )
}
const consent = (orderId: string, over: Record<string, unknown> = {}) => ({
  orderId,
  commandId: testUuid(),
  consent: true,
  consentVersion: ONE_CLICK_CONSENT_VERSION,
  ...over
})
async function notify(envelope: Record<string, string>, afterCaptured?: (e: never, now: string) => Promise<void>) {
  return handlePaymentHttp(
    new Request(`${ORIGIN}/api/payments/redsys/notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(envelope).toString()
    }),
    {
      database: f.database,
      configuration: () => redsysConfig,
      inventory: { assign: f.inventory.assign },
      now: () => utc(),
      afterCaptured: afterCaptured as never
    }
  )
}

describe('saved-card API', () => {
  it('runs consent payment, signed notification, token capture and one-click over HTTP', async () => {
    const first = await f.unpaid()
    const started = (await call('/api/account/saved-cards/consent-payments', {
      token: first.token,
      body: consent(first.orderId)
    }))!
    expect(started.status).toBe(201)
    expect(started.headers.get('cache-control')).toContain('no-store')
    const body = await started.json()
    const intent = f.sqlite
      .prepare('SELECT merchant_order m, amount_gross_cents a FROM payment_intents WHERE id=?')
      .get(body.paymentIntentId) as { m: string; a: number }
    const envelope = await signedEnvelope(intent.m, intent.a, { extra: { Ds_Merchant_Identifier: TOKEN } })
    const ack = await notify(envelope, (e) => captureTokenAfterPayment(e, tokenization()).then(() => undefined))
    expect(ack!.status).toBe(200)
    const saved = f.sqlite.prepare('SELECT id,version FROM payment_saved_tokens').get() as {
      id: string
      version: number
    }
    const second = await f.unpaid()
    const paid = (await call('/api/account/saved-cards/one-click', {
      token: second.token,
      body: {
        tokenId: saved.id,
        expectedVersion: saved.version,
        orderId: second.orderId,
        commandId: testUuid()
      }
    }))!
    expect(paid.status).toBe(200)
    const paidBody = await paid.json()
    expect(paidBody).toMatchObject({ orderId: second.orderId, outcome: 'paid' })
    expect(JSON.stringify(paidBody)).not.toContain(TOKEN)
  })
  it('makes the bank retry when the token hook fails, and a retry then succeeds', async () => {
    const first = await f.unpaid()
    const body = await (await call('/api/account/saved-cards/consent-payments', {
      token: first.token,
      body: consent(first.orderId)
    }))!.json()
    const intent = f.sqlite
      .prepare('SELECT merchant_order m, amount_gross_cents a FROM payment_intents WHERE id=?')
      .get(body.paymentIntentId) as { m: string; a: number }
    const envelope = await signedEnvelope(intent.m, intent.a, { extra: { Ds_Merchant_Identifier: TOKEN } })
    expect(
      (await notify(envelope, async () => {
        throw new Error('boom')
      }))!.status
    ).toBe(500)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 0 })
    expect(
      (await notify(envelope, (e) => captureTokenAfterPayment(e, tokenization()).then(() => undefined)))!.status
    ).toBe(200)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 1 })
  })
  it('reports availability only to an authenticated session', async () => {
    const open = await (await call('/api/account/saved-cards/availability', { method: 'GET' }))!.json()
    expect(open).toEqual({ available: true, consentVersion: ONE_CLICK_CONSENT_VERSION })
    const closed = await (await call(
      '/api/account/saved-cards/availability',
      { method: 'GET' },
      deps({ tokenization: null })
    ))!.json()
    expect(closed.available).toBe(false)
    expect((await call('/api/account/saved-cards/availability', { method: 'GET', session: false }))!.status).toBe(401)
  })
  it('is unavailable while the PAY-022 gate is closed', async () => {
    const { orderId, token } = await f.unpaid()
    const res = (await call(
      '/api/account/saved-cards/consent-payments',
      { token, body: consent(orderId) },
      deps({ tokenization: null })
    ))!
    expect(res.status).toBe(503)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('blocks foreign-origin, cross-site and missing-origin mutations', async () => {
    const { orderId, token } = await f.unpaid()
    const path = '/api/account/saved-cards/consent-payments'
    expect(
      (await call(path, { token, body: consent(orderId), headers: { origin: 'https://evil.example' } }))!.status
    ).toBe(403)
    expect(
      (await call(path, { token, body: consent(orderId), headers: { 'sec-fetch-site': 'cross-site' } }))!.status
    ).toBe(403)
    const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, cookieConfig))!.split(';')[0]!
    const res = await handleTokenizationHttp(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', authorization: `Order ${token}` },
        body: JSON.stringify(consent(orderId))
      }),
      deps()
    )
    expect(res!.status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('requires a session, an order credential, JSON, consistent idempotency and valid input', async () => {
    const { orderId, token } = await f.unpaid()
    const path = '/api/account/saved-cards/consent-payments'
    expect((await call(path, { token, body: consent(orderId), session: false }))!.status).toBe(401)
    expect((await call(path, { body: consent(orderId) }))!.status).toBe(401)
    expect(
      (await call(path, { token, body: consent(orderId), headers: { 'content-type': 'text/plain' } }))!.status
    ).toBe(415)
    expect(
      (await call(path, { token, body: consent(orderId), headers: { 'idempotency-key': testUuid() } }))!.status
    ).toBe(400)
    expect((await call(path, { token, body: consent(orderId, { consent: false }) }))!.status).toBe(400)
    expect((await call(`${path}?x=1`, { token, body: consent(orderId) }))!.status).toBe(403)
    expect((await call(path, { token, method: 'GET' }))!.status).toBe(405)
    expect((await call('/api/account/saved-cards/unknown', { token, body: {} }))!.status).toBe(404)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_consent_requests').get()).toMatchObject({ n: 0 })
  })
  it('owns its whole namespace', async () => {
    expect(ownsSavedCardsNamespace('/api/account/saved-cards')).toBe(true)
    expect(ownsSavedCardsNamespace('/api/account/saved-cards/x')).toBe(true)
    expect(ownsSavedCardsNamespace('/api/account/saved-cardsx')).toBe(false)
    expect(await handleTokenizationHttp(new Request(`${ORIGIN}/api/other`), deps())).toBeNull()
  })
})
