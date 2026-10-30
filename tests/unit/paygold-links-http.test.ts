import { expect, it, beforeEach, afterEach, vi } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handlePayGoldLinksHttp } from '../../workers/payments/paygold-links-http'
const origin = 'https://account.example.invalid',
  configuration = { password: 'synthetic-cookie-password-over-32-characters', maxAgeSeconds: 3600 }
const orderId = '68000000-0000-4000-8000-000000000001',
  quoteId = '68000000-0000-4000-8000-000000000002',
  commandId = '68000000-0000-4000-8000-000000000003',
  token = 'a'.repeat(64)
let f: Awaited<ReturnType<typeof returnsFixture>>,
  cookie: string,
  issue: ReturnType<typeof vi.fn>,
  recover: ReturnType<typeof vi.fn>
beforeEach(async () => {
  f = await returnsFixture()
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  issue = vi.fn(async () => ({
    quoteId,
    orderId,
    paymentIntentId: '68000000-0000-4000-8000-000000000004',
    amountCents: 1000,
    expiresAt: utc(240000),
    url: 'https://paygold.example.invalid/link'
  }))
  recover = vi.fn(async () => ({ quoteId, orderId, expectedVersion: 2, commandId, expiresAt: utc(240000) }))
})
afterEach(() => f?.sqlite.close())
const body = () => ({ orderId, quoteId, expectedVersion: 2, commandId, expiresAt: utc(240000) })
const request = (
  options: { origin?: string; session?: boolean; order?: string; type?: string; key?: string; body?: unknown } = {}
) =>
  new Request(`${origin}/api/account/paygold-links`, {
    method: 'POST',
    headers: {
      origin: options.origin ?? origin,
      cookie: `${options.session === false ? '' : cookie}; neteco-order-access-v2=${options.order ?? `v1.${orderId}.${token}`}`,
      'content-type': options.type ?? 'application/json',
      'idempotency-key': options.key ?? commandId
    },
    body: JSON.stringify(options.body ?? body())
  })
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: configuration,
  issue,
  recover,
  now: () => utc()
})
it('accepts verified session and order cookie, keeping order token out of response', async () => {
  const response = await handlePayGoldLinksHttp(request(), deps())
  expect(response?.status).toBe(201)
  expect(response?.headers.get('cache-control')).toContain('no-store')
  expect(issue).toHaveBeenCalledWith(BUYER_CLAIMS, expect.objectContaining({ orderId, quoteId, orderToken: token }))
  expect(JSON.stringify(await response!.json())).not.toContain(token)
})
it.each(['https://other.invalid', 'null'])('rejects cross-origin mutation %s', async (value) => {
  expect((await handlePayGoldLinksHttp(request({ origin: value }), deps()))?.status).toBe(403)
  expect(issue).not.toHaveBeenCalled()
})
it('rejects missing or duplicate order access cookies and missing session', async () => {
  expect((await handlePayGoldLinksHttp(request({ session: false }), deps()))?.status).toBe(401)
  expect((await handlePayGoldLinksHttp(request({ order: 'garbage' }), deps()))?.status).toBe(401)
  const dup = request()
  dup.headers.set(
    'cookie',
    `${cookie}; neteco-order-access-v2=v1.${orderId}.${token}; neteco-order-access-v2=v1.${orderId}.${token}`
  )
  expect((await handlePayGoldLinksHttp(dup, deps()))?.status).toBe(401)
  expect(issue).not.toHaveBeenCalled()
})
it('rejects wrong content type, key mismatch and excessive or extra body data', async () => {
  expect((await handlePayGoldLinksHttp(request({ type: 'text/plain' }), deps()))?.status).toBe(415)
  expect((await handlePayGoldLinksHttp(request({ key: quoteId }), deps()))?.status).toBe(400)
  expect((await handlePayGoldLinksHttp(request({ body: { ...body(), unknown: 'x' } }), deps()))?.status).toBe(400)
  expect(
    (await handlePayGoldLinksHttp(request({ body: { ...body(), unknown: 'x'.repeat(5000) } }), deps()))?.status
  ).toBe(413)
  expect(issue).not.toHaveBeenCalled()
})
it('owns the route, rejects unsupported methods and unrelated paths', async () => {
  expect(
    (await handlePayGoldLinksHttp(new Request(`${origin}/api/account/paygold-links`, { method: 'GET' }), deps()))
      ?.status
  ).toBe(405)
  expect(await handlePayGoldLinksHttp(new Request(`${origin}/api/account/unrelated`), deps())).toBeNull()
})
it('does not return a link if the identity changes customer during issuance', async () => {
  const other = '68000000-0000-4000-8000-000000000009'
  f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(other, utc(), utc())
  issue.mockImplementationOnce(async () => {
    f.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(other, BUYER_CLAIMS.identityId)
    return {
      quoteId,
      orderId,
      paymentIntentId: '68000000-0000-4000-8000-000000000004',
      amountCents: 1000,
      expiresAt: body().expiresAt,
      url: 'https://paygold.example.invalid/link'
    }
  })
  expect((await handlePayGoldLinksHttp(request(), deps()))?.status).toBe(401)
})
it('derives the order credential from the converted checkout cart cookie without exposing it', async () => {
  const { createCart } = await import('../../workers/catalog/cart')
  const { deriveOrderToken } = await import('../../workers/catalog/checkout')
  const cart = await createCart(f.database, { correlationId: 'paygold-http-test', now: utc() })
  const req = request()
  req.headers.set('cookie', `${cookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`)
  const response = await handlePayGoldLinksHttp(req, deps())
  expect(response?.status).toBe(201)
  expect(issue).toHaveBeenCalledWith(
    BUYER_CLAIMS,
    expect.objectContaining({ orderToken: await deriveOrderToken(cart.token, orderId) })
  )
  expect(JSON.stringify(await response!.json())).not.toContain(cart.token)
})
it('recovers a command through a private authenticated endpoint after a page reload', async () => {
  const req = new Request(`${origin}/api/account/paygold-links/recover?quoteId=${quoteId}&orderId=${orderId}`, {
    headers: { cookie: `${cookie}; neteco-order-access-v2=v1.${orderId}.${token}` }
  })
  const response = await handlePayGoldLinksHttp(req, deps())
  expect(response?.status).toBe(200)
  expect(response?.headers.get('cache-control')).toContain('private')
  expect(await response?.json()).toEqual({
    attempt: { quoteId, orderId, expectedVersion: 2, commandId, expiresAt: utc(240000) }
  })
  expect(recover).toHaveBeenCalledWith(BUYER_CLAIMS, { quoteId, orderId, orderToken: token })
})
it('does not recover from cross-site requests or without the order credential', async () => {
  const url = `${origin}/api/account/paygold-links/recover?quoteId=${quoteId}&orderId=${orderId}`
  const cross = new Request(url, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })
  expect((await handlePayGoldLinksHttp(cross, deps()))?.status).toBe(403)
  expect((await handlePayGoldLinksHttp(new Request(url, { headers: { cookie } }), deps()))?.status).toBe(401)
  expect(recover).not.toHaveBeenCalled()
})
