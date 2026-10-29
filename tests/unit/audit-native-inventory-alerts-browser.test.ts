import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'
import { deterministicTestData, FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleInventoryAlertsHttp } from '../../workers/catalog/inventory-alerts-http'
import { inventoryAlertIntentHash } from '../../shared/inventory-alerts'
import {
  INVENTORY_ALERTS_BROWSER_SCENARIOS,
  auditNativeInventoryAlertsBrowser,
  createInventoryAlertsBrowserBridge
} from '../../scripts/lib/audit-native-inventory-alerts-browser'
const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test',
  configuration = { password: 'synthetic-inventory-browser-cookie-password-more-than-32', maxAgeSeconds: 3600 }
const now = FIXED_TEST_INSTANT.replace('.000Z', 'Z')
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>,
  cookie: string,
  data = deterministicTestData('inventory-browser')
let dispatch: (request: Request) => Promise<Response>, snapshotInventory: () => Promise<string>
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_TEST_INSTANT)
  data = deterministicTestData('inventory-browser')
  connection.mockReset()
  fixture = await openAdminInventoryFixture()
  for (const name of [
    '0063_order_annotations.sql',
    '0064_company_admin_review.sql',
    '0065_account_privacy.sql',
    '0066_account_preferences.sql',
    '0067_inventory_alerts.sql'
  ])
    fixture.sqlite.exec(await readFile('db/d1/migrations/' + name, 'utf8'))
  cookie = (await issueD1SessionCookie(
    fixture.database,
    { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 },
    configuration
  ))!.split(';')[0]!
  dispatch = async (request) =>
    (await handleInventoryAlertsHttp(request, {
      database: fixture.database,
      origin,
      sessionCookieConfiguration: configuration,
      edgeLimiter: { limit: async () => ({ success: true }) },
      rateLimitPepper: 'synthetic-inventory-browser-edge-pepper-more-than-32',
      now: () => now
    })) ?? new Response(null, { status: 404 })
  snapshotInventory = async () =>
    createHash('sha256')
      .update(
        JSON.stringify(
          [
            'inventory_balances',
            'inventory_movements',
            'inventory_reservations',
            'inventory_reservation_lines',
            'orders',
            'payment_commands',
            'payment_events'
          ].map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
        )
      )
      .digest('hex')
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.useRealTimers()
})
const variant = { variantId: 11, sku: 'SYNTHETIC-SKU', threshold: 20 }
const setup = (override: Partial<{ dispatch: typeof dispatch; snapshotInventory: typeof snapshotInventory }> = {}) =>
  createInventoryAlertsBrowserBridge({
    origin,
    adminCookie: cookie,
    dispatch,
    snapshotInventory,
    ...variant,
    ...override
  })
function request(path: string, method = 'GET', body?: unknown, key = data.uuid(), hash?: string) {
  return new Request(origin + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.167',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
}
const reason = 'Synthetic explicit inventory operator decision'
async function configure(bridge: Awaited<ReturnType<typeof setup>>) {
  const key = data.uuid(),
    input = { expectedVersion: 0, threshold: 20, reason }
  const result = await bridge.forward(request('/api/admin/inventory/variants/11/alert-policy', 'PUT', input, key))
  expect(result.action).toBe('fulfill')
  await bridge.forward(request('/api/admin/inventory/variants/11/alert-policy'))
  await bridge.forward(request('/api/admin/inventory/alerts?state=open'))
  return bridge.state().episodeId!
}
it('preserves ordinary extra cookies through real threshold, ACK recovery and reevaluation without stock changes', async () => {
  const before = await snapshotInventory()
  const observed = vi.fn(dispatch)
  const bridge = await setup({ dispatch: observed })
  cookie = `neteco-cart-v2=synthetic-cart; ${cookie}; neteco-consent=necessary`
  const forward = async (candidate: Request) => {
    const result = await bridge.forward(candidate)
    expect(observed.mock.calls.some(([sent]) => sent === candidate)).toBe(true)
    expect(candidate.headers.get('cookie')).toBe(cookie)
    return result
  }
  expect(
    (
      await forward(
        request('/api/admin/inventory/variants/11/alert-policy', 'PUT', {
          expectedVersion: 0,
          threshold: 20,
          reason
        })
      )
    ).action
  ).toBe('fulfill')
  await forward(request('/api/admin/inventory/variants/11/alert-policy'))
  await forward(request('/api/admin/inventory/alerts?state=open'))
  const id = bridge.state().episodeId!
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  const key = data.uuid()
  const input = { expectedVersion: 1, reason }
  const hash = await inventoryAlertIntentHash('ack', id, input)
  expect(await forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', input, key))).toEqual({
    action: 'abort',
    reason: 'proven_inventory_ack_response_lost'
  })
  await forward(request(`/api/admin/inventory/alerts/commands/${key}`, 'GET', undefined, data.uuid(), hash))
  await forward(request(`/api/admin/inventory/alerts?state=all&alertId=${id}`))
  expect(bridge.state()).toMatchObject({ receiptGets: 1, freshAckGets: 1, recovered: true })
  await forward(request('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 100 }))
  await forward(request(`/api/admin/inventory/alerts?state=all&alertId=${id}`))
  expect(await bridge.assertComplete()).toMatchObject({ thresholdPuts: 1, ackPosts: 1, lostResponses: 1 })
  expect(await snapshotInventory()).toBe(before)
  expect(fixture.sqlite.prepare('SELECT id,state,version FROM inventory_alert_episodes').get()).toEqual({
    id,
    state: 'acknowledged',
    version: 2
  })
})
it.each(['foreign', 'duplicate-same', 'duplicate-foreign', 'absent'])(
  'rejects %s session cookies before inventory policy, ACK or evaluation dispatch',
  async (kind) => {
    const observed = vi.fn(dispatch)
    const bridge = await setup({ dispatch: observed })
    const episodeId = await configure(bridge)
    const original = cookie
    const candidateCookie =
      kind === 'foreign'
        ? 'neteco-session=foreign'
        : kind === 'duplicate-same'
          ? `${original}; ${original}`
          : kind === 'duplicate-foreign'
            ? `${original}; neteco-session=foreign`
            : 'neteco-consent=necessary; neteco-cart-v2=synthetic-cart'
    const before = await snapshotInventory()
    for (const candidate of [
      request('/api/admin/inventory/variants/11/alert-policy', 'PUT', { expectedVersion: 0, threshold: 20, reason }),
      request(`/api/admin/inventory/alerts/${episodeId}/ack`, 'POST', { expectedVersion: 1, reason }),
      request('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 100 })
    ]) {
      candidate.headers.set('cookie', candidateCookie)
      observed.mockClear()
      expect((await bridge.forward(candidate)).action).toBe('abort')
      expect(observed).not.toHaveBeenCalled()
    }
    expect(bridge.state()).toMatchObject({ thresholdPuts: 1, ackPosts: 0, evaluationPosts: 0 })
    expect(await snapshotInventory()).toBe(before)
  }
)
it('declares exactly two scenarios and not-run performs no connection, preparation, dispatch or snapshot', async () => {
  const prepareVariant = vi.fn(),
    send = vi.fn(),
    snapshot = vi.fn(),
    scenario = vi.fn()
  expect(INVENTORY_ALERTS_BROWSER_SCENARIOS).toHaveLength(2)
  expect(new Set(INVENTORY_ALERTS_BROWSER_SCENARIOS).size).toBe(2)
  expect(
    await auditNativeInventoryAlertsBrowser({
      origin,
      adminCookie: cookie,
      dispatch: send,
      prepareVariant,
      snapshotInventory: snapshot,
      scenario,
      browserMode: 'not-run'
    })
  ).toMatchObject({ scenarios: 0, browserExecuted: false })
  for (const spy of [connection, prepareVariant, send, snapshot, scenario]) expect(spy).not.toHaveBeenCalled()
})
it('never prepares or mutates data when required browser connection fails', async () => {
  connection.mockRejectedValue(new Error('synthetic unavailable'))
  const prepareVariant = vi.fn(),
    send = vi.fn(),
    snapshot = vi.fn()
  await expect(
    auditNativeInventoryAlertsBrowser({
      origin,
      adminCookie: cookie,
      dispatch: send,
      prepareVariant,
      snapshotInventory: snapshot
    })
  ).rejects.toThrow()
  expect(connection).toHaveBeenCalledOnce()
  expect(prepareVariant).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(snapshot).not.toHaveBeenCalled()
})
it('forwards real policy, loses only a proven committed ACK and recovers exact receipt/current before reevaluation with unchanged stock', async () => {
  const before = await snapshotInventory(),
    bridge = await setup(),
    id = await configure(bridge)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  const key = data.uuid(),
    input = { expectedVersion: 1, reason },
    hash = await inventoryAlertIntentHash('ack', id, input)
  expect(await bridge.forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', input, key))).toEqual({
    action: 'abort',
    reason: 'proven_inventory_ack_response_lost'
  })
  expect(fixture.sqlite.prepare('SELECT id,state,version FROM inventory_alert_episodes').get()).toEqual({
    id,
    state: 'acknowledged',
    version: 2
  })
  expect(bridge.state()).toMatchObject({ thresholdPuts: 1, ackPosts: 1, lostResponses: 1, recovered: false })
  expect((await bridge.forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', input, key))).action).toBe(
    'abort'
  )
  await bridge.forward(request(`/api/admin/inventory/alerts/commands/${key}`, 'GET', undefined, data.uuid(), hash))
  await bridge.forward(request(`/api/admin/inventory/alerts?state=all&alertId=${id}`))
  expect(bridge.state()).toMatchObject({ receiptGets: 1, freshAckGets: 1, recovered: true })
  await bridge.forward(request('/api/admin/inventory/alerts/evaluate', 'POST', { limit: 100 }))
  await bridge.forward(request(`/api/admin/inventory/alerts?state=all&alertId=${id}`))
  // The explicit rejected second ACK above is a boundary negative, not a browser success.
  expect(bridge.state().ackPosts).toBe(1)
  expect(await snapshotInventory()).toBe(before)
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_alert_commands').get()!.n).toBe(3)
})
it('rejects foreign origins and unrelated/wrong-target inventory writes without dispatch', async () => {
  const send = vi.fn(dispatch),
    bridge = await setup({ dispatch: send })
  send.mockClear()
  const external = new Request('https://outside.example.test/api/admin/inventory/alerts', { method: 'GET' })
  expect((await bridge.forward(external)).action).toBe('abort')
  expect(
    (
      await bridge.forward(
        request('/api/admin/inventory/variants/12/alert-policy', 'PUT', { expectedVersion: 0, threshold: 20, reason })
      )
    ).action
  ).toBe('abort')
  expect(
    (await bridge.forward(request('/api/admin/inventory/variants/11/receipts', 'POST', { quantity: 1 }))).action
  ).toBe('abort')
  expect(send).not.toHaveBeenCalled()
})
it('does not lose a non-200 ACK or mark it recovered', async () => {
  let rejectAck = false
  const bridge = await setup({
    dispatch: async (req) =>
      rejectAck && req.method === 'POST' && req.url.endsWith('/ack')
        ? new Response(null, { status: 409 })
        : dispatch(req)
  })
  const id = await configure(bridge)
  rejectAck = true
  const result = await bridge.forward(
    request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', { expectedVersion: 1, reason })
  )
  expect(result.action).toBe('fulfill')
  expect(bridge.state()).toMatchObject({ lostResponses: 0, recovered: false })
})
it('refuses to conceal an ACK if returned receipt identity is wrong', async () => {
  const bridge = await setup({
    dispatch: async (req) => {
      const result = await dispatch(req)
      if (req.method === 'POST' && req.url.endsWith('/ack') && result.status === 200)
        return Response.json(
          { ...((await result.json()) as object), commandId: data.uuid() },
          { headers: result.headers }
        )
      return result
    }
  })
  const id = await configure(bridge)
  await expect(
    bridge.forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', { expectedVersion: 1, reason }))
  ).rejects.toThrow()
  expect(bridge.state().lostResponses).toBe(0)
})
it('fails closed on changed inventory digest rather than reporting successful read-only recovery', async () => {
  let changed = false
  const original = snapshotInventory
  const bridge = await setup({ snapshotInventory: async () => (changed ? '0'.repeat(64) : original()) })
  const id = await configure(bridge)
  changed = true
  await expect(
    bridge.forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', { expectedVersion: 1, reason }))
  ).rejects.toThrow()
  expect(bridge.state().lostResponses).toBe(0)
})
it('does not confirm recovery from a manual receipt with the wrong applied version', async () => {
  let wrongRecovery = false
  const bridge = await setup({
    dispatch: async (req) => {
      const response = await dispatch(req)
      if (wrongRecovery && req.url.includes('/alerts/commands/') && response.status === 200) {
        const envelope = (await response.json()) as {
          source: string
          outcome: string
          receipt: Record<string, unknown>
        }
        return Response.json(
          { ...envelope, receipt: { ...envelope.receipt, version: 3 } },
          { headers: response.headers }
        )
      }
      return response
    }
  })
  const id = await configure(bridge),
    key = data.uuid(),
    input = { expectedVersion: 1, reason }
  await bridge.forward(request(`/api/admin/inventory/alerts/${id}/ack`, 'POST', input, key))
  wrongRecovery = true
  const hash = await inventoryAlertIntentHash('ack', id, input)
  await expect(
    bridge.forward(request(`/api/admin/inventory/alerts/commands/${key}`, 'GET', undefined, data.uuid(), hash))
  ).rejects.toThrow()
  expect(bridge.state()).toMatchObject({ ackPosts: 1, lostResponses: 1, recovered: false })
})
