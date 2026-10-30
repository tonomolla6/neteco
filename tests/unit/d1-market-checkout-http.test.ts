import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCheckoutMarketHttp } from '../../workers/catalog/market-checkout-http'
const origin = 'https://market.neteco.test',
  config = { password: 'synthetic-market-cookie-password-over-32', maxAgeSeconds: 3600 },
  key = '11111111-1111-4111-8111-111111111111'
const input = {
  currency: 'GBP',
  expectedVersion: 0,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v1',
  paymentMethods: ['card']
}
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  origin,
  sessionCookieConfiguration: config,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-market-pepper-more-than-32',
  now: () => utc()
})
const request = (method = 'GET', body: unknown = input) =>
  new Request(`${origin}/api/admin/checkout-markets/GB`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'CF-Connecting-IP': '192.0.2.8'
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  })
it('returns private profile and replays the save', async () => {
  expect((await handleCheckoutMarketHttp(request(), deps()))?.status).toBe(404)
  expect((await handleCheckoutMarketHttp(request('POST'), deps()))?.status).toBe(200)
  expect((await handleCheckoutMarketHttp(request('POST'), deps()))?.status).toBe(200)
  const res = await handleCheckoutMarketHttp(request(), deps())
  expect(res?.headers.get('cache-control')).toContain('private')
  expect(await res!.json()).toMatchObject({ market: 'GB', currency: 'GBP', version: 1 })
})
it.each(['missing', 'foreign', 'crosssite'])('rejects %s origin', async (mode) => {
  const req = request('POST')
  if (mode === 'missing') req.headers.delete('origin')
  if (mode === 'foreign') req.headers.set('origin', 'https://foreign.invalid')
  if (mode === 'crosssite') req.headers.set('sec-fetch-site', 'cross-site')
  expect((await handleCheckoutMarketHttp(req, deps()))?.status).toBe(403)
})
it('denies customer and unsupported method', async () => {
  cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  expect((await handleCheckoutMarketHttp(request(), deps()))?.status).toBe(403)
  expect((await handleCheckoutMarketHttp(request('DELETE'), deps()))?.status).toBe(405)
})
it('rejects extra fields, invalid values, oversized body', async () => {
  expect((await handleCheckoutMarketHttp(request('POST', { ...input, market: 'ES' }), deps()))?.status).toBe(400)
  expect((await handleCheckoutMarketHttp(request('POST', { ...input, exchangeDenominator: 0 }), deps()))?.status).toBe(
    400
  )
  expect((await handleCheckoutMarketHttp(request('POST', { x: 'x'.repeat(9000) }), deps()))?.status).toBe(413)
})
