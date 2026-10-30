import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, utc } from './d1-returns-fixture'
import { configureCheckoutMarket } from '../../workers/catalog/market-checkout-policy'
import { handlePublicCheckoutMarketHttp } from '../../workers/catalog/market-checkout-http'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'
const origin = 'https://market.neteco.test'
let f: Awaited<ReturnType<typeof returnsFixture>>
const profile = {
  market: 'GB',
  currency: 'GBP',
  expectedVersion: 0,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v1',
  paymentMethods: ['card', 'bank_transfer']
}
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0120_market_catalog_international_shipping.sql', 'utf8'))
  await seedDefaultMarkets(f.database, { now: () => utc() })
  await configureCheckoutMarket(f.database, CLAIMS, '11111111-1111-4111-8111-111111111111', profile, {
    now: () => utc()
  })
})
afterEach(() => f?.sqlite.close())
const deps = (result: 'allowed' | 'limited' | 'unavailable' = 'allowed') => ({
  database: f.database,
  edgeLimiter: {
    limit: async () => {
      if (result === 'unavailable') throw new Error('down')
      return { success: result === 'allowed' }
    }
  } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-market-pepper-more-than-32'
})
const get = (path = '/api/checkout-markets/GB', method = 'GET') =>
  new Request(origin + path, { method, headers: { 'CF-Connecting-IP': '192.0.2.8' } })
it('publishes only the buyer-facing fields of the latest profile of an active market', async () => {
  await configureCheckoutMarket(
    f.database,
    CLAIMS,
    '22222222-2222-4222-8222-222222222222',
    { ...profile, expectedVersion: 1, goodsTaxBps: 1900 },
    { now: () => utc() }
  )
  const response = (await handlePublicCheckoutMarketHttp(get(), deps()))!
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({
    market: 'GB',
    currency: 'GBP',
    version: 2,
    exchangeNumerator: 86,
    exchangeDenominator: 100,
    goodsTaxBps: 1900,
    shippingNetMinor: 450,
    shippingTaxBps: 2000,
    termsVersion: 'gb-terms-v1',
    paymentMethods: ['card', 'bank_transfer']
  })
  expect(JSON.stringify(body)).not.toMatch(/actor|session|payload_hash|command/)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
})
it('does not publish markets without a profile or deactivated by the catalog', async () => {
  expect((await handlePublicCheckoutMarketHttp(get('/api/checkout-markets/FR'), deps()))?.status).toBe(404)
  f.sqlite.prepare("UPDATE catalog_markets SET is_active=0 WHERE code='GB'").run()
  expect((await handlePublicCheckoutMarketHttp(get(), deps()))?.status).toBe(404)
})
it('ignores unrelated and malformed paths so other routes keep ownership', async () => {
  for (const path of [
    '/api/checkout-markets/gb',
    '/api/checkout-markets/GBR',
    '/api/checkout-markets/GB/x',
    '/api/checkout-markets'
  ])
    expect(await handlePublicCheckoutMarketHttp(get(path), deps())).toBeNull()
})
it('is read-only and rejects query strings', async () => {
  const post = (await handlePublicCheckoutMarketHttp(get('/api/checkout-markets/GB', 'POST'), deps()))!
  expect(post.status).toBe(405)
  expect(post.headers.get('allow')).toBe('GET')
  expect((await handlePublicCheckoutMarketHttp(get('/api/checkout-markets/GB?x=1'), deps()))?.status).toBe(400)
})
it('applies abuse limits before reading D1 and fails closed when the limiter is down', async () => {
  expect((await handlePublicCheckoutMarketHttp(get(), deps('limited')))?.status).toBe(429)
  expect((await handlePublicCheckoutMarketHttp(get(), deps('unavailable')))?.status).toBe(503)
})
