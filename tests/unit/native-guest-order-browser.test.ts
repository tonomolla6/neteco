import { readFile, readdir } from 'node:fs/promises'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { returnsFixture, utc } from './d1-returns-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { handleGuestOrderAccessHttp } from '../../workers/catalog/guest-order-access-http'
import { handleD1RefundsRequest } from '../../workers/refunds/http'
import {
  auditNativeGuestOrderBrowser,
  createGuestOrderBrowserBridge,
  GUEST_ORDER_BROWSER_SCENARIOS
} from '../../scripts/lib/audit-native-guest-order-browser'
const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const clock = deterministicTestData('guest-order-browser', '2026-10-09T00:00:00Z'),
  origin = 'https://shop-audit.neteco.test',
  configuration = { password: 'synthetic-guest-browser-cookie-password-more32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>,
  orderId: string,
  emailLink: string,
  env: CloudflareEnv,
  dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock.date())
  connection.mockReset()
  fixture = await returnsFixture()
  fixture.sqlite.function('guest_browser_now', () => utc())
  const database = fixture.database
  fixture.database = {
    ...database,
    prepare: (sql: string) =>
      database.prepare(sql.replaceAll("strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'guest_browser_now()'))
  } as D1Database
  for (const name of (await readdir('db/d1/migrations')).sort())
    if (/^006[3-9]_.*\.sql$/.test(name)) fixture.sqlite.exec(await readFile('db/d1/migrations/' + name, 'utf8'))
  await applyDeliveryPreferencesMigration(fixture.sqlite)
  orderId = await fixture.order({ owned: false, paid: false, delivered: false })
  await publishEmailOutbox(
    fixture.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(fixture.database, message, utc())
      }
    },
    { now: utc() }
  )
  const messages: string[] = []
  expect(
    await dispatchTransactionalEmails(
      fixture.database,
      {
        send: async (message) => {
          messages.push(message.text)
          return { messageId: 'synthetic-no-provider' }
        }
      },
      {
        enabled: true,
        from: 'orders@neteco.test',
        now: utc(),
        guestOrderLinks: { publicOrigin: origin, sessionCookieConfiguration: configuration }
      }
    )
  ).toMatchObject({ sent: 1 })
  emailLink = messages[0]!.match(/https:\/\/shop-audit\.neteco\.test\/pedido\/[a-f0-9-]+\?token=[a-f0-9]{64}/)![0]
  env = {
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: configuration.password,
    AUTH_TOKEN_PEPPER: 'synthetic-guest-browser-token-pepper-more32',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-guest-browser-rate-pepper-more32',
    AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    DB: fixture.database
  } as unknown as CloudflareEnv
  dispatch = async (request) =>
    (await handleGuestOrderAccessHttp(request, {
      database: fixture.database,
      origin,
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      sessionCookieConfiguration: configuration,
      now: () => utc()
    })) ??
    (await handleD1RefundsRequest(request, {
      database: fixture.database,
      origin,
      sessionCookieConfiguration: configuration,
      appEnvironment: 'local',
      now: () => utc()
    })) ??
    worker.fetch(request, env)
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.useRealTimers()
})
const input = () => ({
  origin,
  dispatch,
  orderId,
  emailLink,
  forbiddenValues: ['foreign-buyer-sentinel@example.invalid']
})
const request = (url = emailLink, method = 'GET', cookie?: string) =>
  new Request(url, {
    method,
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.173', ...(cookie ? { Cookie: cookie } : {}) }
  })
async function opened() {
  const bridge = await createGuestOrderBrowserBridge(input()),
    result = await bridge.forward(request())
  expect(result.action).toBe('fulfill')
  if (result.action !== 'fulfill') throw new Error('expected real landing')
  expect(result.response.status).toBe(303)
  return { bridge, cookie: result.response.headers.get('set-cookie')!.split(';')[0]! }
}
it('forwards the real email landing and checks the actual view-only grant without financial/customer authority', async () => {
  const { bridge, cookie } = await opened()
  for (const suffix of ['', '/lines', '/fiscal', '/refunds'])
    expect(
      (await dispatch(request(`${origin}/api/orders/${orderId}${suffix}`, 'GET', cookie))).status,
      `safe path suffix ${suffix}`
    ).toBe(suffix ? 401 : 200)
  await bridge.verifyReadOnlyGrant()
  expect(bridge.state()).toMatchObject({ landings: 1, revoked: false })
})
it('verifies real guest tracking with no cookie renewal, then missing/foreign/revoked authority without new scenarios', async () => {
  const spy = vi.fn(dispatch),
    bridge = await createGuestOrderBrowserBridge({ ...input(), dispatch: spy })
  await bridge.forward(request())
  await bridge.verifyReadOnlyGrant()
  const trackingPath = `/api/orders/${orderId}/tracking`
  const calls = () =>
    spy.mock.calls.map(([req]) => ({
      path: new URL(req.url).pathname,
      cookie: req.headers.get('cookie'),
      method: req.method
    }))
  expect(calls().filter((call) => call.path === trackingPath && call.cookie)).toHaveLength(1)
  expect(calls().filter((call) => call.path === trackingPath && !call.cookie)).toHaveLength(1)
  expect(
    calls().some((call) => call.path === '/api/orders/00000000-0000-4000-8000-000000000008/tracking' && call.cookie)
  ).toBe(true)
  await bridge.revoke()
  expect(calls().filter((call) => call.path === trackingPath && call.cookie)).toHaveLength(2)
  expect(
    calls()
      .filter((call) => call.path.endsWith('/tracking'))
      .every((call) => call.method === 'GET')
  ).toBe(true)
  expect(GUEST_ORDER_BROWSER_SCENARIOS).toHaveLength(2)
})
it.each(['audience', 'orderId', 'private_field'] as const)(
  'rejects a tampered real tracking response: %s',
  async (field) => {
    const bridge = await createGuestOrderBrowserBridge({
      ...input(),
      dispatch: async (req) => {
        const response = await dispatch(req)
        if (new URL(req.url).pathname !== `/api/orders/${orderId}/tracking` || response.status !== 200) return response
        const dto = (await response.json()) as Record<string, unknown>
        if (field === 'audience') dto.audience = 'admin'
        else if (field === 'orderId') dto.orderId = '00000000-0000-4000-8000-000000000008'
        else dto.reason = 'Private internal reason'
        return Response.json(dto, { headers: response.headers })
      }
    })
    await bridge.forward(request())
    await expect(bridge.verifyReadOnlyGrant()).rejects.toThrow()
  }
)
it('revokes only through real CSRF-checked logout and then proves cookie/link denial', async () => {
  const { bridge } = await opened(),
    before = JSON.stringify(
      ['inventory_balances', 'payment_intents', 'payment_events', 'fiscal_documents'].map((t) =>
        fixture.sqlite.prepare(`SELECT * FROM ${t}`).all()
      )
    )
  await bridge.verifyReadOnlyGrant()
  await bridge.revoke()
  expect(bridge.state().revoked).toBe(true)
  expect(
    JSON.stringify(
      ['inventory_balances', 'payment_intents', 'payment_events', 'fiscal_documents'].map((t) =>
        fixture.sqlite.prepare(`SELECT * FROM ${t}`).all()
      )
    )
  ).toBe(before)
})
it.each(['POST', 'PUT', 'DELETE'])(
  'blocks browser %s operations before dispatch (including logout/payment)',
  async (method) => {
    const spy = vi.fn(dispatch),
      bridge = await createGuestOrderBrowserBridge({ ...input(), dispatch: spy })
    expect(await bridge.forward(request(`${origin}/api/orders/${orderId}/payment`, method))).toEqual({
      action: 'abort',
      reason: 'unapproved_write'
    })
    expect(spy).not.toHaveBeenCalled()
  }
)
it('blocks external traffic, arbitrary claim URLs and token referrers without forwarding credentials', async () => {
  const spy = vi.fn(dispatch),
    bridge = await createGuestOrderBrowserBridge({ ...input(), dispatch: spy })
  expect((await bridge.forward(request('https://external.invalid/'))).action).toBe('abort')
  expect((await bridge.forward(request(emailLink + '&extra=private'))).action).toBe('abort')
  const referrer = request(origin + '/_nuxt/file.js')
  referrer.headers.set('referer', emailLink)
  expect((await bridge.forward(referrer)).action).toBe('abort')
  expect(spy).not.toHaveBeenCalled()
})
it('does not accept a malformed redirect or an unrelated private cookie as landing proof', async () => {
  const bridge = await createGuestOrderBrowserBridge({
    ...input(),
    dispatch: async () =>
      new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': 'neteco-session=synthetic' } })
  })
  await expect(bridge.forward(request())).rejects.toThrow()
})
it('does not accept a successful broad-authority DTO as a view-only grant', async () => {
  const { bridge } = await opened()
  const original = dispatch
  dispatch = async (req) =>
    req.url === `${origin}/api/orders/${orderId}`
      ? Response.json({ source: 'cloudflare', id: orderId, accessMode: 'owner' })
      : original(req)
  const invalid = await createGuestOrderBrowserBridge({ ...input(), dispatch: (req) => dispatch(req) })
  await invalid.forward(request())
  await expect(invalid.verifyReadOnlyGrant()).rejects.toThrow()
  expect(bridge.state().revoked).toBe(false)
})
it('rejects stale real cookie/link after revocation without claiming absence or refreshing authority', async () => {
  const { bridge, cookie } = await opened()
  fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
  await expect(bridge.verifyReadOnlyGrant()).rejects.toThrow()
  expect((await dispatch(request(`${origin}/api/orders/${orderId}`, 'GET', cookie))).status).toBe(401)
})
it('NOTRUN emits no scenarios, connection, preparation or Worker calls', async () => {
  const prepareGuestOrder = vi.fn(),
    spy = vi.fn(dispatch),
    scenario = vi.fn()
  expect(
    await auditNativeGuestOrderBrowser({ origin, dispatch: spy, prepareGuestOrder, browserMode: 'not-run', scenario })
  ).toMatchObject({ scenarios: 0, browserExecuted: false })
  expect(connection).not.toHaveBeenCalled()
  expect(prepareGuestOrder).not.toHaveBeenCalled()
  expect(spy).not.toHaveBeenCalled()
  expect(scenario).not.toHaveBeenCalled()
})
it('does not prepare fixtures or emit scenario IDs when private browser connection fails', async () => {
  const prepareGuestOrder = vi.fn(),
    scenario = vi.fn()
  connection.mockRejectedValue(new Error('synthetic unavailable'))
  await expect(auditNativeGuestOrderBrowser({ origin, dispatch, prepareGuestOrder, scenario })).rejects.toThrow()
  expect(prepareGuestOrder).not.toHaveBeenCalled()
  expect(scenario).not.toHaveBeenCalled()
  expect(GUEST_ORDER_BROWSER_SCENARIOS).toHaveLength(2)
})
it('sanitizes browser/navigation failures and closes only its context/connection without emitting acceptance', async () => {
  const closeContext = vi.fn(),
    closeBrowser = vi.fn(),
    scenario = vi.fn(),
    page = {
      on: vi.fn(),
      goto: vi.fn(async () => {
        throw new Error(`${emailLink} Cookie=synthetic-private-credential buyer@example.invalid`)
      })
    },
    context = { route: vi.fn(), newPage: async () => page, close: closeContext }
  connection.mockResolvedValue({ newContext: async () => context, close: closeBrowser })
  let failure: unknown
  try {
    await auditNativeGuestOrderBrowser({ origin, dispatch, prepareGuestOrder: async () => input(), scenario })
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ name: 'GuestOrderBrowserError', stage: 'compiled_guest_view', viewport: 'desktop' })
  expect(String(failure)).not.toContain(new URL(emailLink).searchParams.get('token'))
  expect(String(failure)).not.toContain('buyer@example.invalid')
  expect(String(failure)).not.toContain('synthetic-private-credential')
  expect((failure as Error).cause).toBeUndefined()
  expect(scenario).not.toHaveBeenCalled()
  expect(closeContext).toHaveBeenCalledOnce()
  expect(closeBrowser).toHaveBeenCalledOnce()
})
it('rejects an untrusted fixture origin before forwarding its link or credentials', async () => {
  const spy = vi.fn(dispatch)
  await expect(
    createGuestOrderBrowserBridge({
      ...input(),
      dispatch: spy,
      emailLink: emailLink.replace(origin, 'https://external.invalid')
    })
  ).rejects.toMatchObject({ stage: 'fixture' })
  expect(spy).not.toHaveBeenCalled()
})
