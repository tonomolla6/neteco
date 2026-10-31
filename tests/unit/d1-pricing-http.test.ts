import { describe, expect, it } from 'vitest'
import { pricingFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, key, utc } from './d1-pricing-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handlePricingHttp } from '../../workers/pricing/pricing-http'

const origin = 'https://pricing.neteco.test'
const configuration = { password: 'p'.repeat(40), maxAgeSeconds: 3600 }
async function world() {
  const f = await pricingFixture()
  const admin = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
  const buyer = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  const deps = {
    database: f.database,
    sessionCookieConfiguration: configuration,
    origin,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-rate-limit-pepper-over-32'
  }
  return { ...f, admin, buyer, deps }
}
const call = (
  path: string,
  method: string,
  cookie: string | null,
  body?: unknown,
  extra: Record<string, string> = {}
) =>
  new Request(origin + path, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': key(),
      'cf-connecting-ip': '192.0.2.1',
      ...(cookie ? { cookie } : {}),
      ...extra
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

describe('pricing HTTP', () => {
  it('admin issues credit; the customer reads it and redeems; replay is exact', async () => {
    const f = await world()
    const orderId = await f.order({ paid: false, delivered: false })
    const issue = await handlePricingHttp(
      call('/api/admin/pricing/store-credit/issue', 'POST', f.admin, {
        customerId: CUSTOMER,
        kind: 'compensation_coupon',
        sourceRef: 'case-http-1',
        amountCents: 300,
        expiresInDays: 60,
        reason: 'Compensacion por incidencia'
      }),
      f.deps
    )
    expect(issue?.status).toBe(201)
    const summary = await handlePricingHttp(call('/api/account/store-credit', 'GET', f.buyer), f.deps)
    expect(await summary?.json()).toMatchObject({ balanceCents: 300 })
    const disabledRedeem = await handlePricingHttp(
      call('/api/account/store-credit/redeem', 'POST', f.buyer, { orderId, amountCents: 100 }),
      f.deps
    )
    expect(disabledRedeem?.status).toBe(503)
    expect(await disabledRedeem?.json()).toEqual({ error: { code: 'feature_disabled' } })
    const enabledDeps = { ...f.deps, storeCreditRedemptionEnabled: true }
    const redeem = call('/api/account/store-credit/redeem', 'POST', f.buyer, { orderId, amountCents: 100 })
    const a = await handlePricingHttp(redeem.clone(), enabledDeps)
    const b = await handlePricingHttp(redeem, enabledDeps)
    expect(a?.status).toBe(200)
    expect(await b?.json()).toEqual(await a?.json())
    expect(
      await (await handlePricingHttp(call('/api/account/store-credit', 'GET', f.buyer), f.deps))?.json()
    ).toMatchObject({ balanceCents: 200 })
  })
  it('rejects anonymous, non-admin and foreign-origin callers; private headers on every answer', async () => {
    const f = await world()
    const path = '/api/admin/pricing/auto-discounts'
    expect((await handlePricingHttp(call(path, 'GET', null), f.deps))?.status).toBe(401)
    expect((await handlePricingHttp(call(path, 'GET', f.buyer), f.deps))?.status).toBe(403)
    const evil = await handlePricingHttp(call(path, 'POST', f.admin, {}, { origin: 'https://evil.example' }), f.deps)
    expect(evil?.status).toBe(403)
    expect(evil?.headers.get('cache-control')).toContain('no-store')
    expect((await handlePricingHttp(call('/api/account/store-credit', 'GET', null), f.deps))?.status).toBe(401)
    // Dot-segments are normalised by URL parsing: they never reach the namespace.
    expect(await handlePricingHttp(call('/api/admin/pricing/%2e%2e/auto-discounts', 'GET', f.admin), f.deps)).toBeNull()
  })
  it('rules CRUD with CAS over HTTP, and the public preview is anonymous', async () => {
    const f = await world()
    f.sqlite.exec('UPDATE variants SET cost_net_cents = 100')
    const rule = { code: 'HTTP-10', name: 'Regla http', kind: 'all', scopeIds: [] }
    expect(
      (
        await handlePricingHttp(
          call('/api/admin/pricing/auto-discounts', 'POST', f.admin, {
            ...rule,
            kind: 'basket',
            benefit: { kind: 'percent', basisPoints: 1000 },
            minBasketGrossCents: 0,
            priority: 5,
            stacking: 'exclusive',
            segment: 'all',
            marginFloorBasisPoints: 1000,
            customerMessage: 'Diez por ciento',
            startsAt: utc(-60000),
            endsAt: null
          }),
          f.deps
        )
      )?.status
    ).toBe(201)
    const listed = (await (await handlePricingHttp(
      call('/api/admin/pricing/auto-discounts', 'GET', f.admin),
      f.deps
    ))!.json()) as { rules: Array<{ id: string }> }
    const id = listed.rules[0]!.id
    const st = await handlePricingHttp(
      call(`/api/admin/pricing/auto-discounts/${id}/status`, 'POST', f.admin, { expectedVersion: 1, status: 'active' }),
      f.deps
    )
    expect(st?.status).toBe(200)
    const stale = await handlePricingHttp(
      call(`/api/admin/pricing/auto-discounts/${id}/status`, 'POST', f.admin, { expectedVersion: 1, status: 'paused' }),
      f.deps
    )
    expect(stale?.status).toBe(409)
    const pv = await handlePricingHttp(
      call('/api/pricing/auto-discounts/preview', 'POST', null, { lines: [{ variantId: 'v-1-1', quantity: 2 }] }),
      f.deps
    )
    expect(pv?.status).toBe(200)
    expect(await pv?.json()).toMatchObject({
      totals: { discountGrossCents: 100 },
      explanations: [{ message: 'Diez por ciento' }]
    })
    const bad = await handlePricingHttp(
      call('/api/pricing/auto-discounts/preview', 'POST', null, {
        lines: [{ variantId: 'v-1-1', quantity: 2, unitGrossCents: 1 }]
      }),
      f.deps
    )
    expect(bad?.status).toBe(400)
  })
})
