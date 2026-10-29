import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { packingFixture, CLAIMS, REASON } from './d1-order-packing-fixture'
import { orderPackingIntentHash } from '../../shared/order-packing'
import {
  auditNativeOrderPackingBrowser,
  createPackingBrowserBridge
} from '../../scripts/lib/audit-native-order-packing-browser'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'Explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test'
let fixture: Awaited<ReturnType<typeof packingFixture>>,
  cookie: string,
  dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  connect.mockClear()
  fixture = await packingFixture({ stage: 'packed' })
  const password = 'synthetic-packing-browser-password-more-than-32'
  cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  dispatch = (request) =>
    worker.fetch(
      request,
      {
        DB: fixture.database,
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-packing-browser-rate-pepper-more-than-32',
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
      } as unknown as CloudflareEnv,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    )
})
afterEach(() => fixture.sqlite.close())
function request(input: unknown, key = crypto.randomUUID()) {
  return new Request(`${origin}/api/admin/orders/${fixture.orderId}/packing/commands`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.170',
      'Content-Type': 'application/json',
      'Idempotency-Key': key
    },
    body: JSON.stringify(input)
  })
}
function pack() {
  return {
    action: 'pack',
    expectedVersion: 0,
    expectedFulfillmentVersion: 2,
    reason: REASON,
    parcels: [0, 1].map(() => ({
      weightGrams: 1000,
      widthMm: 200,
      heightMm: 100,
      depthMm: 100,
      contents: [{ lineIndex: 0, quantity: 2 }]
    }))
  }
}
it('NOTRUN performs zero preparation, SQL, dispatch or browser connection', async () => {
  const prepare = vi.fn(),
    send = vi.fn(),
    sql = vi.fn()
  const result = await auditNativeOrderPackingBrowser({
    origin,
    database: { prepare: sql, batch: sql } as unknown as D1Database,
    dispatch: send,
    prepare,
    browserMode: 'not-run'
  })
  expect(result.scenarios).toBe(0)
  expect(prepare).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(sql).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
})
it('loses pack201 only after real immutable ledger, matching recovery and current packing proof; never reposts', async () => {
  const send = vi.fn(dispatch),
    bridge = createPackingBrowserBridge({
      origin,
      database: fixture.database,
      dispatch: send,
      adminCookie: cookie,
      orderId: fixture.orderId
    })
  const key = crypto.randomUUID(),
    input = pack(),
    before = fixture.economic()
  expect(await bridge.forward(request(input, key))).toEqual({ action: 'abort', reason: 'lost_packing_response' })
  expect(bridge.proof).toMatchObject({ packPosts: 1, dispatchPosts: 0, lostResponses: 1 })
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').get()).toEqual({ n: 1 })
  expect(fixture.economic()).toEqual(before)
  await expect(bridge.forward(request(input, key))).rejects.toThrow()
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').get()).toEqual({ n: 1 })
  expect(
    send.mock.calls.some(([req]) => req.method === 'GET' && new URL(req.url).pathname.endsWith('/commands/' + key))
  ).toBe(true)
  const hash = await orderPackingIntentHash(fixture.orderId, input),
    base = `${origin}/api/admin/orders/${fixture.orderId}/packing`
  await bridge.forward(
    new Request(base + '/commands/' + key, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.170', 'X-Neteco-Command-Payload-Hash': hash }
    })
  )
  await bridge.forward(new Request(base, { headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.170' } }))
  const manual = {
    action: 'manual_dispatch',
    expectedVersion: 1,
    expectedFulfillmentVersion: 2,
    reason: REASON,
    shipments: [0, 1].map((parcelIndex) => ({
      parcelIndex,
      carrier: 'Synthetic carrier',
      shipmentNumber: `SYNTHETIC-${parcelIndex}`,
      trackingNumber: `TRACK-${parcelIndex}`,
      externalLabelReference: `DOCUMENT-${parcelIndex}`
    })),
    actualNetCents: 700,
    taxBps: 2100
  }
  const completed = await bridge.forward(request(manual))
  expect(completed.action).toBe('fulfill')
  if (completed.action === 'fulfill') expect(completed.response.status).toBe(201)
  expect(bridge.proof).toMatchObject({ packPosts: 1, dispatchPosts: 1, lostResponses: 1 })
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').get()).toEqual({ n: 2 })
  expect(fixture.economic()).toEqual(before)
})
it('does not disguise rejected HTTP or fabricate a committed command before losing a response', async () => {
  const bridge = createPackingBrowserBridge({
    origin,
    database: fixture.database,
    dispatch,
    adminCookie: cookie,
    orderId: fixture.orderId
  })
  const result = await bridge.forward(request({ ...pack(), expectedVersion: 9 }))
  expect(result.action).toBe('fulfill')
  if (result.action === 'fulfill') expect(result.response.status).toBe(409)
  expect(bridge.proof.lostResponses).toBe(0)
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').get()).toEqual({ n: 0 })
})
it('rejects a transport receipt whose order correlation differs from the real committed ledger', async () => {
  const bridge = createPackingBrowserBridge({
    origin,
    database: fixture.database,
    adminCookie: cookie,
    orderId: fixture.orderId,
    dispatch: async (req) => {
      const response = await dispatch(req)
      if (req.method !== 'POST' || response.status !== 201) return response
      return Response.json({ ...((await response.json()) as object), orderId: crypto.randomUUID() }, { status: 201 })
    }
  })
  await expect(bridge.forward(request(pack()))).rejects.toThrow()
  expect(bridge.proof.lostResponses).toBe(0)
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM order_packing_commands').get()).toEqual({ n: 1 })
})
it('blocks externals and all unrelated writes before dispatch', async () => {
  const send = vi.fn(dispatch),
    bridge = createPackingBrowserBridge({
      origin,
      database: fixture.database,
      dispatch: send,
      adminCookie: cookie,
      orderId: fixture.orderId
    })
  expect((await bridge.forward(new Request('https://external.invalid/'))).action).toBe('abort')
  expect((await bridge.forward(new Request(origin + '/api/payments', { method: 'POST', body: '{}' }))).action).toBe(
    'abort'
  )
  expect(send).not.toHaveBeenCalled()
})
