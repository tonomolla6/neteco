import { afterEach, describe, expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, utc } from './d1-returns-fixture'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { handleStorefrontCheckoutHttp } from '../../workers/catalog/storefront-checkout'

let fixture: Awaited<ReturnType<typeof returnsFixture>> | undefined
afterEach(() => fixture?.sqlite.close())

async function read(coupon: boolean) {
  fixture = await returnsFixture()
  if (coupon)
    await provisionPromotionFixture(
      fixture.sqlite,
      {
        id: deterministicUuid('order-breakdown-coupon'),
        version: 1,
        code: 'ODD101',
        status: 'active',
        channel: 'online',
        startsAt: utc(-60000),
        endsAt: utc(3600000),
        benefit: { kind: 'fixed', grossCents: 101 },
        scope: { kind: 'all' },
        segment: 'all',
        totalLimit: null,
        perCustomerLimit: null,
        volumeMode: 'stack_volume'
      },
      CLAIMS.identityId
    )
  const orderId = await fixture.order({
    paid: false,
    delivered: false,
    quantity: 3,
    ...(coupon ? { couponCode: 'ODD101' } : {})
  })
  const changes = fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n
  const response = await handleStorefrontCheckoutHttp(
    new Request(`https://shop.example.test/api/orders/${orderId}`, {
      headers: { Cookie: 'neteco-session=synthetic', 'CF-Connecting-IP': '192.0.2.91' }
    }),
    {
      database: fixture.database,
      dispatch: async () => {
        throw new Error('unexpected_dispatch')
      },
      edgeLimiter: { limit: async () => ({ success: true }) },
      rateLimitPepper: 'synthetic-rate-limit-pepper-at-least-32',
      paymentConfiguration: () => null,
      session: async () => BUYER_CLAIMS,
      authenticationEnabled: true,
      now: () => utc()
    }
  )
  expect(response?.status).toBe(200)
  expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes)
  return (await response!.json()) as {
    items: Array<{
      price: number
      qty: number
      lineIndex: number
      lineBaseGrossCents: number
      discountGrossCents: number
      lineNetCents: number
      lineTaxCents: number
      lineGrossCents: number
    }>
    subtotal: number
    subtotalBaseGrossCents: number
    discountGrossCents: number
    subtotalNetCents: number
    goodsTaxCents: number
    shippingNetCents: number
    shippingTaxCents: number
    total: number
    tax: number
  }
}

describe('customer contractual order amounts after a coupon', () => {
  it('returns exact odd-cent line amounts, not unit price multiplied as the payable amount', async () => {
    const body = await read(true)
    expect(body.items[0]).toMatchObject({
      price: 500,
      qty: 3,
      lineIndex: 0,
      lineBaseGrossCents: 1500,
      discountGrossCents: 101,
      lineNetCents: 1156,
      lineTaxCents: 243,
      lineGrossCents: 1399
    })
    expect(body).toMatchObject({
      subtotal: 1399,
      subtotalBaseGrossCents: 1500,
      discountGrossCents: 101,
      subtotalNetCents: 1156,
      goodsTaxCents: 243,
      shippingNetCents: 0,
      shippingTaxCents: 0,
      total: 1399,
      tax: 243
    })
  })
  it('projects historical no-coupon orders without requiring migration 0072 columns', async () => {
    const body = await read(false)
    expect(body.items[0]).toMatchObject({ lineBaseGrossCents: 1500, discountGrossCents: 0, lineGrossCents: 1500 })
    expect(body).toMatchObject({ subtotalBaseGrossCents: 1500, discountGrossCents: 0, subtotal: 1500, total: 1500 })
  })
})
