import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { handleStorefrontShippingHttp } from '../../workers/catalog/storefront-shipping'
import type { PromotionRule } from '../../shared/promotions'
import { testUuid } from '../support/deterministic'

async function world(segment: PromotionRule['segment'] = 'all') {
  const f = await returnsFixture()
  await provisionPromotionFixture(
    f.sqlite,
    {
      id: testUuid(),
      version: 1,
      code: 'TEST101',
      status: 'active',
      channel: 'online',
      startsAt: utc(-3600000),
      endsAt: utc(3600000),
      benefit: { kind: 'fixed', grossCents: 101 },
      scope: { kind: 'all' },
      segment,
      totalLimit: null,
      perCustomerLimit: null,
      volumeMode: 'stack_volume'
    },
    CLAIMS.identityId
  )
  const cart = await createCart(f.database, { now: utc(), correlationId: 'coupon-http' })
  await setCartLine(f.database, {
    ...cart,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'add',
    now: utc(),
    correlationId: 'coupon-http'
  })
  const deps = {
    database: f.database,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-only-pepper-32-characters',
    session: async () => BUYER_CLAIMS,
    authenticationEnabled: true,
    dispatch: async (command: Record<string, unknown>) => {
      const response = await handleCartCommand(command, {
        database: f.database,
        getResponse: async () => undefined,
        putResponse: async () => {},
        setAlarm: async () => {}
      })
      return Response.json(response.body, { status: response.status })
    }
  }
  const key = testUuid()
  const request = (couponCode: string, extra: Record<string, unknown> = {}) =>
    new Request('https://shop.test/api/shipping/rates', {
      method: 'POST',
      headers: {
        origin: 'https://shop.test',
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.10',
        cookie: `neteco-cart-v2=v1.${cart.cartId}.${cart.token}; neteco-session=synthetic-cookie`
      },
      body: JSON.stringify({ postalCode: '46870', city: 'Ontinyent', couponCode, ...extra })
    })
  return { ...f, deps, request }
}

describe('storefront coupon boundary', () => {
  it('uses only the server promotion and verified owner when quoting delivery and final purchase totals', async () => {
    const f = await world('registered')
    try {
      const response = await handleStorefrontShippingHttp(f.request('test101'), f.deps)
      expect(response?.status).toBe(200)
      expect(response?.headers.get('cache-control')).toContain('no-store')
      const body = (await response!.json()) as {
        promotion: unknown
        rates: Array<{ profile: string; totalGrossCents: number }>
      }
      expect(body.promotion).toMatchObject({ code: 'TEST101', applied: true, discountGrossCents: 101 })
      expect(body.rates.find((rate) => rate.profile === 'pickup')?.totalGrossCents).toBe(899)
      const changed = await handleStorefrontShippingHttp(f.request('OTHER'), f.deps)
      expect(changed?.status).toBe(409)
    } finally {
      f.sqlite.close()
    }
  })
  it('never accepts customer claims or economic discounts from the browser body', async () => {
    const f = await world()
    try {
      const response = await handleStorefrontShippingHttp(
        f.request('TEST101', { ownerSession: BUYER_CLAIMS, discountGrossCents: 999 }),
        f.deps
      )
      expect(response?.status).toBe(400)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM checkout_quote_promotions').get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
})
