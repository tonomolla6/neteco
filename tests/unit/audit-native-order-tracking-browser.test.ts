import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { trackingFixture, configuration } from './d1-order-tracking-http-fixture'
import { createOrderTrackingBrowserBridge } from '../../scripts/lib/audit-native-order-tracking-browser'
import { orderTrackingSchema } from '../../shared/order-tracking'

const origin = 'https://shop-audit.neteco.test'
let fixture: Awaited<ReturnType<typeof trackingFixture>>, dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  fixture = await trackingFixture()
  dispatch = (request) =>
    worker.fetch(
      request,
      {
        APP_ENV: 'local',
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: configuration.password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-tracking-browser-pepper-more-than-32',
        AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
      } as unknown as CloudflareEnv,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    )
})
afterEach(() => {
  fixture?.sqlite.close()
})
function bridge(send = dispatch) {
  return createOrderTrackingBrowserBridge({
    origin,
    orderId: fixture.ownedOrderId,
    cookie: fixture.buyerCookie,
    audience: 'customer',
    dispatch: send
  })
}
function request(path = `/api/orders/${fixture.ownedOrderId}/tracking`, method = 'GET') {
  return new Request(origin + path, {
    method,
    headers: { Cookie: fixture.buyerCookie, 'CF-Connecting-IP': '192.0.2.173' }
  })
}
it('observes actual authorized tracking GET with strict correlation and zero SQL writes', async () => {
  const forward = bridge(),
    before = fixture.sqlite.prepare('SELECT total_changes() n').get()
  const result = await forward.forward(request())
  expect(result.action).toBe('fulfill')
  if (result.action === 'fulfill') {
    expect(result.response.status).toBe(200)
    expect(orderTrackingSchema.parse(await result.response.json())).toMatchObject({
      orderId: fixture.ownedOrderId,
      audience: 'customer',
      carrierStatus: 'not_connected',
      packing: { parcelCount: 2 }
    })
  }
  expect(forward.proof.trackingReads).toBe(1)
  expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('rejects a transport DTO from another order after the actual server GET, not a fabricated SQL response', async () => {
  const send = vi.fn(async (req: Request) => {
    const response = await dispatch(req)
    expect(response.status).toBe(200)
    return Response.json({ ...((await response.json()) as object), orderId: crypto.randomUUID() }, { status: 200 })
  })
  await expect(bridge(send).forward(request())).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(1)
})
it('blocks external, all business writes and unrelated private reads before dispatch', async () => {
  const send = vi.fn(dispatch),
    forward = bridge(send)
  for (const req of [
    new Request('https://external.invalid/'),
    request(`/api/orders/${fixture.ownedOrderId}/tracking`, 'POST'),
    request('/api/admin/orders'),
    request(`/api/orders/${crypto.randomUUID()}/tracking`)
  ])
    expect((await forward.forward(req)).action).toBe('abort')
  expect(send).not.toHaveBeenCalled()
})
