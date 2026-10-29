import { describe, expect, it } from 'vitest'
import { creditWorld } from './d1-b2b-credit-fixture'
import { CLAIMS, BUYER_CLAIMS } from './d1-returns-fixture'
import { placeOrder } from '../../workers/catalog/checkout'
import { handleB2BHttp } from '../../workers/catalog/b2b-http'
const origin = 'https://credit-test.neteco.test'
async function world() {
  const f = await creditWorld(),
    input = await f.input()
  f.terms(input.expectedTotalGrossCents)
  const order = await placeOrder(f.database, input)
  if (order.outcome !== 'order_created') throw new Error(order.outcome)
  const deps = {
    database: f.database,
    origin,
    environment: 'local',
    now: () => f.now,
    session: async () => CLAIMS,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-rate-limit-pepper-over-32'
  }
  return { ...f, orderId: order.body.id as string, total: input.expectedTotalGrossCents, deps }
}
const request = (path: string, method = 'GET', body?: unknown, key = crypto.randomUUID()) =>
  new Request(origin + path, {
    method,
    headers: { origin, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'CF-Connecting-IP': '192.0.2.1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
describe('local reconciliation HTTP', () => {
  it('lists and simulates a transfer using a replayable command', async () => {
    const f = await world()
    try {
      let list = await handleB2BHttp(request('/api/admin/b2b/transfers'), f.deps)
      expect(await list?.json()).toMatchObject({
        enabled: true,
        orders: [{ orderId: f.orderId, simulatedOutstandingCents: f.total }]
      })
      const key = crypto.randomUUID(),
        path = `/api/admin/b2b/transfers/${f.orderId}`,
        body = {
          expectedOutstandingCents: f.total,
          amountCents: f.total,
          bankReference: 'FAKE-TEST-1',
          reason: 'Simulación comercial'
        }
      const first = await handleB2BHttp(request(path, 'PUT', body, key), f.deps)
      expect(first?.status).toBe(200)
      expect(await first?.json()).toMatchObject({ validationOnly: true, simulatedOutstandingCents: 0 })
      expect((await handleB2BHttp(request(path, 'PUT', body, key), f.deps))?.status).toBe(200)
      list = await handleB2BHttp(request('/api/admin/b2b/transfers'), f.deps)
      expect(await list?.json()).toMatchObject({ orders: [{ orderId: f.orderId, simulatedOutstandingCents: 0 }] })
    } finally {
      f.sqlite.close()
    }
  })
  it('disables fake execution outside local and requires admin permission', async () => {
    const f = await world()
    try {
      const path = `/api/admin/b2b/transfers/${f.orderId}`,
        body = {
          expectedOutstandingCents: f.total,
          amountCents: f.total,
          bankReference: 'FAKE-TEST-1',
          reason: 'Simulación comercial'
        }
      expect((await handleB2BHttp(request(path, 'PUT', body), { ...f.deps, environment: 'production' }))?.status).toBe(
        503
      )
      expect(
        (await handleB2BHttp(request(path, 'PUT', body), { ...f.deps, session: async () => BUYER_CLAIMS }))?.status
      ).toBe(403)
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_transfer_simulations').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
})
