import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as checkout from '../../workers/catalog/checkout'
import worker from '../../workers/canary'
import shop from '../../workers/shop'
import { returnsFixture, utc } from './d1-returns-fixture'
import { issueD1GuestOrderLinkClaim } from '../../workers/catalog/guest-order-access'

const renderer = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('Unexpected renderer', { headers: { 'content-type': 'text/html' } }))
}))
vi.mock('#neteco/nitro-renderer', () => ({ default: renderer }))
const origin = 'https://guest-entrypoints.neteco.test'
const configuration = { password: 'synthetic-guest-entrypoint-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>,
  orderId: string,
  originalToken = '',
  claim = ''
let env: CloudflareEnv
beforeEach(async () => {
  renderer.fetch.mockClear()
  fixture = await returnsFixture()
  const placeOrder = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation(async (...args) => {
    const result = await placeOrder(...args)
    if (result.outcome === 'order_created') originalToken = String(result.body.orderToken)
    return result
  })
  orderId = await fixture.order({ owned: false, paid: true, delivered: true })
  claim = await issueD1GuestOrderLinkClaim(fixture.database, orderId, originalToken, configuration)
  env = {
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: configuration.password,
    AUTH_TOKEN_PEPPER: 'synthetic-guest-entrypoint-token-pepper-over32',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-guest-entrypoint-edge-pepper-over32',
    AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    DB: fixture.database
  } as unknown as CloudflareEnv
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})
function request(path: string, method = 'GET', body?: unknown, cookie?: string) {
  return new Request(origin + path, {
    method,
    headers: {
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.169',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}
async function exchange() {
  const response = await worker.fetch(request(`/api/orders/${orderId}/access`, 'POST', { token: claim }), env)
  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('neteco-guest-order-access-v1=')
  expect(cookie).not.toContain(originalToken)
  return cookie.split(';')[0]!
}
it('exchanges a view-only link through the real API and reads the confirmed public header', async () => {
  const cookie = await exchange()
  const response = await worker.fetch(request(`/api/orders/${orderId}`, 'GET', undefined, cookie), env)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    source: 'cloudflare',
    accessMode: 'view_only',
    id: orderId,
    fulfillmentStatus: 'delivered',
    email: 'buyer@example.invalid'
  })
})
it('preserves the ordinary checkout bearer DTO without imposing the sealed guest restriction', async () => {
  const cookie = `neteco-order-access-v2=v1.${orderId}.${originalToken}`
  const response = await worker.fetch(request(`/api/orders/${orderId}`, 'GET', undefined, cookie), env)
  expect(response.status).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  expect(body).toMatchObject({ source: 'cloudflare', id: orderId })
  expect(body).not.toHaveProperty('accessMode')
})
it('handles a signed landing before SSR and redirects without exposing link claims or checkout bearers', async () => {
  const response = await shop.fetch(request(`/pedido/${orderId}?token=${claim}`), env, {} as ExecutionContext)
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe(`/pedido/${orderId}`)
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(await response.text()).toBe('')
  expect(renderer.fetch).not.toHaveBeenCalled()
})
it('preserves the ordinary order page without a link token', async () => {
  const response = await shop.fetch(request(`/pedido/${orderId}`), env, {} as ExecutionContext)
  expect(response.status).toBe(200)
  expect(renderer.fetch).toHaveBeenCalledTimes(1)
})
it.each(['uppercase', 'encoded', 'trailing-slash'] as const)(
  'rejects the %s guest landing alias before its secret can reach SSR',
  async (alias) => {
    const path =
      alias === 'uppercase'
        ? `/PEDIDO/${orderId}`
        : alias === 'encoded'
          ? `/pe%64ido/${orderId}`
          : `/pedido/${orderId}/`
    const response = await shop.fetch(request(`${path}?token=${claim}`), env, {} as ExecutionContext)
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await response.text()).not.toContain(claim)
    expect(renderer.fetch).not.toHaveBeenCalled()
  }
)
it('does not turn a guest-view cookie into a session, payment or private account grant', async () => {
  const cookie = await exchange()
  const session = await worker.fetch(request('/api/_auth/session', 'GET', undefined, cookie), env)
  expect(await session.json()).toEqual({})
  const wrongPurpose = cookie.replace(/^neteco-guest-order-access-v1=/, 'neteco-session=')
  expect(await (await worker.fetch(request('/api/_auth/session', 'GET', undefined, wrongPurpose), env)).json()).toEqual(
    {}
  )
  expect((await worker.fetch(request(`/api/orders/${orderId}/lines`, 'GET', undefined, cookie), env)).status).toBe(401)
  expect(
    (await worker.fetch(request('/api/checkout/pay', 'POST', { orderId, method: 'tarjeta' }, cookie), env)).status
  ).toBe(401)
})
it('does not fall back to a weak secret or accept a foreign configured/request origin', async () => {
  expect(
    (
      await worker.fetch(request(`/api/orders/${orderId}/access`, 'POST', { token: claim }), {
        ...env,
        NUXT_SESSION_PASSWORD: ''
      })
    ).status
  ).toBe(503)
  expect(
    (
      await shop.fetch(
        request(`/pedido/${orderId}?token=${claim}`),
        { ...env, AUTH_ORIGIN: 'https://other.invalid' },
        {} as ExecutionContext
      )
    ).status
  ).toBe(403)
  expect(renderer.fetch).not.toHaveBeenCalled()
})
it('revokes the original link and sealed cookie only after a valid-CSRF logout', async () => {
  const cookie = await exchange()
  const foreign = request('/api/auth/logout', 'POST', undefined, cookie)
  foreign.headers.set('origin', 'https://foreign.invalid')
  expect((await worker.fetch(foreign, env)).status).toBe(403)
  expect((await worker.fetch(request(`/api/orders/${orderId}`, 'GET', undefined, cookie), env)).status).toBe(200)
  const logout = await worker.fetch(request('/api/auth/logout', 'POST', undefined, cookie), env)
  expect(logout.status).toBe(200)
  expect(logout.headers.get('set-cookie')).toContain('neteco-guest-order-access-v1=; Max-Age=0')
  expect((await worker.fetch(request(`/api/orders/${orderId}`, 'GET', undefined, cookie), env)).status).toBe(401)
  expect((await worker.fetch(request(`/api/orders/${orderId}/access`, 'POST', { token: claim }), env)).status).toBe(404)
})
it('fails closed when auth is disabled without rendering the bearer landing or accessing D1', async () => {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_db')
  })
  const disabled = { ...env, AUTH_ENABLED: 'false', DB: { prepare } } as unknown as CloudflareEnv
  expect(
    (await worker.fetch(request(`/api/orders/${orderId}/access`, 'POST', { token: claim }), disabled)).status
  ).toBe(503)
  expect(
    (await shop.fetch(request(`/pedido/${orderId}?token=${claim}`), disabled, {} as ExecutionContext)).status
  ).toBe(503)
  expect(prepare).not.toHaveBeenCalled()
  expect(renderer.fetch).not.toHaveBeenCalled()
})
it('purges a guest snapshot if its original grant is revoked during asynchronous header reads', async () => {
  const cookie = await exchange(),
    prepare = fixture.database.prepare.bind(fixture.database)
  const database = {
    ...fixture.database,
    prepare(sql: string) {
      const statement = prepare(sql)
      if (!sql.startsWith('SELECT shipping_gross_cents')) return statement
      const bind = statement.bind.bind(statement)
      return {
        ...statement,
        bind(...args: unknown[]) {
          const bound = bind(...args)
          return {
            ...bound,
            async first<T>() {
              const result = await bound.first<T>()
              fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
              return result
            }
          }
        }
      } as D1PreparedStatement
    }
  } as D1Database
  const result = await worker.fetch(request(`/api/orders/${orderId}`, 'GET', undefined, cookie), {
    ...env,
    DB: database
  })
  expect(result.status).toBe(401)
  expect(JSON.stringify(await result.json())).not.toMatch(/buyer@example|Carrer Major|Original buyer/)
})
