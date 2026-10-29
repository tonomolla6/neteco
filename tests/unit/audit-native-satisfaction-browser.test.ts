import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { supportFixture, CLAIMS, utc } from './d1-support-fixture'
import { executeSupportAdminCommand } from '../../workers/support/operations'
import { handleSatisfactionHttp } from '../../workers/support/satisfaction-http'
import { customerSatisfactionSchema, satisfactionIntentHash } from '../../shared/support-satisfaction'
import { deterministicTestData } from '../fixtures/deterministic'
import {
  SATISFACTION_BROWSER_SCENARIOS,
  auditNativeSatisfactionBrowser,
  createSatisfactionBrowserBridge
} from '../../scripts/lib/audit-native-satisfaction-browser'
const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test'
let f: Awaited<ReturnType<typeof supportFixture>>, supportRef: string
let data = deterministicTestData('satisfaction-browser')
let dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  data = deterministicTestData('satisfaction-browser')
  connection.mockReset()
  f = await supportFixture()
  f.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0068_support_satisfaction.sql', import.meta.url), 'utf8')
  )
  supportRef = (await f.ticket()).publicRef
  await executeSupportAdminCommand(
    f.database,
    CLAIMS,
    supportRef,
    {
      action: 'update',
      expectedVersion: 1,
      reason: 'Synthetic browser resolved source',
      state: 'resolved',
      priority: 'normal',
      ownerId: null,
      nextActionAt: null,
      slaDueAt: null,
      resolution: 'Synthetic confirmed support response.'
    },
    { now: utc(), idempotencyKey: data.uuid() }
  )
  dispatch = async (request) =>
    (await handleSatisfactionHttp(request, { ...f.deps, origin })) ?? new Response(null, { status: 404 })
})
afterEach(() => f?.sqlite.close())
const endpoint = (kind = 'support') => `/api/account/satisfaction/${kind}/${kind === 'support' ? supportRef : f.order}`
const setup = (override: Partial<{ dispatch: typeof dispatch }> = {}) =>
  createSatisfactionBrowserBridge({
    database: f.database,
    dispatch,
    origin,
    adminCookie: f.adminCookie,
    customerCookie: f.customerCookie,
    supportRef,
    deliveryOrderId: f.order,
    ...override
  })
function request(path: string, body?: unknown, key = data.uuid(), hash?: string, admin = false) {
  return new Request(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie: admin ? f.adminCookie : f.customerCookie,
      origin,
      'cf-connecting-ip': '192.0.2.168',
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
}
async function body(kind = 'support') {
  const current = customerSatisfactionSchema.parse(await (await dispatch(request(endpoint(kind)))).json())
  expect(current.eligible).toBe(true)
  return {
    score: 5,
    comment: kind === 'support' ? 'Synthetic browser support feedback' : 'Synthetic browser delivery feedback',
    privacyAcknowledged: true as const,
    expectedSourceVersion: current.target.version,
    expectedPolicyHash: current.privacy!.policyHash
  }
}
it('defines two journeys and NOTRUN has zero connection, preparation, dispatch and database reads', async () => {
  const prepare = vi.fn(),
    send = vi.fn(),
    prepareSql = vi.fn(),
    scenario = vi.fn()
  expect(SATISFACTION_BROWSER_SCENARIOS).toHaveLength(2)
  expect(new Set(SATISFACTION_BROWSER_SCENARIOS).size).toBe(2)
  expect(
    await auditNativeSatisfactionBrowser({
      database: { prepare: prepareSql } as unknown as D1Database,
      origin,
      adminCookie: f.adminCookie,
      dispatch: send,
      prepare,
      scenario,
      browserMode: 'not-run'
    })
  ).toMatchObject({ scenarios: 0, browserExecuted: false })
  for (const spy of [prepare, send, prepareSql, scenario, connection]) expect(spy).not.toHaveBeenCalled()
})
it('required fails when remote browser is unavailable without preparing or dispatching', async () => {
  connection.mockRejectedValue(new Error('no private endpoint'))
  const prepare = vi.fn(),
    send = vi.fn()
  await expect(
    auditNativeSatisfactionBrowser({
      database: f.database,
      origin,
      adminCookie: f.adminCookie,
      dispatch: send,
      prepare
    })
  ).rejects.toThrow()
  expect(connection).toHaveBeenCalledOnce()
  expect(prepare).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})
it('loses only a real committed support response, recovers exact receipt/current and delivers the other own rating once', async () => {
  const before = f.economic(),
    bridge = await setup(),
    support = await body(),
    key = data.uuid()
  expect(await bridge.forward(request(endpoint(), support, key))).toEqual({
    action: 'abort',
    reason: 'proven_satisfaction_response_lost'
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM support_satisfaction_commands').get()).toEqual({ n: 1 })
  const hash = await satisfactionIntentHash('support', supportRef, support)
  expect((await bridge.forward(request(endpoint() + '/commands/' + key, undefined, key, hash))).action).toBe('fulfill')
  await bridge.forward(request(endpoint()))
  expect(bridge.state().recovered).toBe(true)
  expect((await bridge.forward(request(endpoint('delivery'), await body('delivery')))).action).toBe('fulfill')
  await bridge.forward(request(endpoint('delivery')))
  await bridge.forward(request('/api/admin/support/satisfaction?comments=false', undefined, undefined, undefined, true))
  await bridge.forward(request('/api/admin/support/satisfaction?comments=true', undefined, undefined, undefined, true))
  await bridge.forward(
    request(
      '/api/admin/support/satisfaction?source=support&score=5&comments=true',
      undefined,
      undefined,
      undefined,
      true
    )
  )
  await expect(bridge.assertComplete()).resolves.toMatchObject({ supportPosts: 1, deliveryPosts: 1, recovered: true })
  expect(f.sqlite.prepare('SELECT count(*) n FROM support_satisfaction_commands').get()).toEqual({ n: 2 })
  expect(f.economic()).toEqual(before)
})
it('does not fake a committed response when actual HTTP rejects the POST', async () => {
  const bridge = await setup({
    dispatch: async (req) => (req.method === 'POST' ? new Response(null, { status: 503 }) : dispatch(req))
  })
  const result = await bridge.forward(request(endpoint(), await body()))
  expect(result.action).toBe('fulfill')
  expect(result.action === 'fulfill' && result.response.status).toBe(503)
  expect(f.sqlite.prepare('SELECT count(*) n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
  await expect(bridge.assertComplete()).rejects.toThrow()
})
it('rejects a second POST even with the same body/key rather than hiding a duplicate UI send', async () => {
  const bridge = await setup(),
    input = await body(),
    key = data.uuid()
  await bridge.forward(request(endpoint(), input, key))
  expect(await bridge.forward(request(endpoint(), input, key))).toEqual({
    action: 'abort',
    reason: 'duplicate_satisfaction_post'
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM support_satisfaction_commands').get()).toEqual({ n: 1 })
})
it('blocks foreign origins and unrelated writes before real dispatch', async () => {
  const count = vi.fn(dispatch),
    bridge = await setup({ dispatch: count })
  count.mockClear()
  const result = await bridge.forward(new Request('https://external.invalid/', { method: 'POST' }))
  expect(result.action).toBe('abort')
  expect((await bridge.forward(request('/api/cart/items', { quantity: 1 }))).action).toBe('abort')
  expect(count).not.toHaveBeenCalled()
  expect(f.economic().orders).toHaveLength(1)
})
