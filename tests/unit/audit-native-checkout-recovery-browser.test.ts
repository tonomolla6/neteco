import { describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { Page } from '@playwright/test'
import {
  auditNativeCheckoutRecoveryBrowser,
  createCheckoutRecoveryBrowserBridge,
  checkoutRecoveryForm
} from '../../scripts/lib/audit-native-checkout-recovery-browser'

const origin = 'https://shop-audit.neteco.test'
const orderId = '11111111-1111-4111-8111-111111111111'
const key = '22222222-2222-4222-8222-222222222222'
const request = (path: string, body?: unknown, commandKey = key) =>
  new Request(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'idempotency-key': commandKey, origin },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
function fixture() {
  const events: string[] = []
  const dispatch = vi.fn(async (incoming: Request) => {
    events.push('dispatch:' + new URL(incoming.url).pathname)
    if (new URL(incoming.url).pathname === '/api/orders')
      return Response.json({ id: orderId }, { status: 201, headers: { 'set-cookie': 'order-grant=must-be-lost' } })
    if (new URL(incoming.url).pathname === '/api/checkout/pay')
      return Response.json({
        ok: true,
        redirect: {
          actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
          method: 'POST',
          fields: { Ds_MerchantParameters: 'signed-local-fixture' }
        }
      })
    return Response.json({ orderId })
  })
  const readOrder = vi.fn(async () => {
    events.push('readback:order')
  })
  const readPayment = vi.fn(async () => {
    events.push('readback:payment')
  })
  return {
    events,
    dispatch,
    readOrder,
    readPayment,
    bridge: createCheckoutRecoveryBrowserBridge({ origin, dispatch, readOrder, readPayment })
  }
}
describe('compiled checkout browser fault injection never fabricates Worker success', () => {
  it('selects only the checkout form when newsletter adds a second email and submit', async () => {
    const window = new Window()
    window.document.body.innerHTML =
      '<form id="checkout"><input autocomplete="name"><input autocomplete="email"><button type="submit">Comprar</button></form><footer><form><input autocomplete="email"><button type="submit">Suscribir</button></form></footer>'
    const locate = (selector: string) => {
      const nodes = [...window.document.querySelectorAll(selector)]
      return {
        nodes,
        filter: ({ has }: { has: { nodes: typeof nodes } }) => ({
          count: async () => nodes.filter((node) => has.nodes.some((child) => node.contains(child))).length
        }),
        count: async () => nodes.length
      }
    }
    expect(await checkoutRecoveryForm({ locator: locate } as unknown as Pick<Page, 'locator'>).count()).toBe(1)
    window.happyDOM.abort()
  })
  it('reports not-run without seeding state, connecting a browser or claiming acceptance', async () => {
    const dispatch = vi.fn(),
      scenario = vi.fn()
    const result = await auditNativeCheckoutRecoveryBrowser({
      dispatch,
      database: {} as D1Database,
      origin,
      variantId: 1,
      quantity: 1,
      scenario,
      browserMode: 'not-run'
    })
    expect(result).toMatchObject({
      scenarios: 0,
      browserStatus: 'not_run',
      requests: null,
      orderId: null,
      paymentPosts: null,
      screenshots: [],
      providerSubmission: false,
      productionBrowserAcceptance: false
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(scenario).not.toHaveBeenCalled()
  })
  it('drops the order response and its grant only after real successful dispatch and order readback', async () => {
    const f = fixture()
    const result = await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    expect(f.events).toEqual(['dispatch:/api/orders', 'readback:order'])
    expect(result).toEqual({ action: 'abort', reason: 'lost_order_response' })
    expect(f.bridge.proof.orderId).toBe(orderId)
    expect(f.readOrder).toHaveBeenCalledWith(orderId, expect.any(Request))
  })
  it('preserves a failed Worker response instead of calling it a committed lost order', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce(Response.json({ error: { code: 'invalid_input' } }, { status: 400 }))
    const result = await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    expect(result.action).toBe('fulfill')
    expect(f.readOrder).not.toHaveBeenCalled()
    expect(f.bridge.proof.orderId).toBeNull()
  })
  it('refuses a successful-looking order response without a valid committed identity', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce(Response.json({ id: 'invented' }, { status: 201 }))
    await expect(f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))).rejects.toThrow()
    expect(f.readOrder).not.toHaveBeenCalled()
  })
  it('does not record a lost order when durable readback fails', async () => {
    const f = fixture()
    f.readOrder.mockRejectedValueOnce(new Error('order not committed'))
    await expect(f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))).rejects.toThrow(
      'order not committed'
    )
    expect(f.bridge.proof.orderId).toBeNull()
  })
  it('rejects a second order before it can create any additional durable state', async () => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    await expect(f.bridge.forward(request('/api/orders', { cartId: 'replacement-cart' }))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('blocks external requests and unrelated mutations before dispatch', async () => {
    const f = fixture()
    expect((await f.bridge.forward(new Request('https://example.invalid/bank'))).action).toBe('abort')
    expect((await f.bridge.forward(request('/api/admin/catalog/import-jobs', { arbitrary: true }))).action).toBe(
      'abort'
    )
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('forwards normal same-origin reads to the actual dispatch', async () => {
    const f = fixture()
    const result = await f.bridge.forward(request('/checkout'))
    expect(result.action).toBe('fulfill')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('forwards only the real optional-consent analytics-session deletion, not unrelated DELETE writes', async () => {
    const f = fixture()
    const deletion = new Request(origin + '/api/analytics/session', { method: 'DELETE' })
    expect((await f.bridge.forward(deletion)).action).toBe('fulfill')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect((await f.bridge.forward(new Request(origin + '/api/orders/' + orderId, { method: 'DELETE' }))).action).toBe(
      'abort'
    )
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('accepts the recovered order payment only through real dispatch/readback and prevents bank submission', async () => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    await f.bridge.forward(request('/api/checkout/recover'))
    const body = { orderId, method: 'tarjeta' }
    expect(await f.bridge.forward(request('/api/checkout/pay', body))).toEqual({
      action: 'abort',
      reason: 'prevent_provider_submission'
    })
    expect(f.events.slice(-2)).toEqual(['dispatch:/api/checkout/pay', 'readback:payment'])
    expect(f.readPayment).toHaveBeenCalledWith(orderId, key, body, expect.objectContaining({ ok: true }))
    expect(f.bridge.proof.paymentPosts).toBe(1)
  })
  it.each([
    { body: { orderId, method: 'tarjeta', token: 'legacy-token' }, key },
    { body: { orderId: '33333333-3333-4333-8333-333333333333', method: 'tarjeta' }, key },
    { body: { orderId, method: 'tarjeta' }, key: '' }
  ])('refuses malformed or mismatched payment commands before dispatch: %#', async (bad) => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    const before = f.dispatch.mock.calls.length
    await expect(f.bridge.forward(request('/api/checkout/pay', bad.body, bad.key))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(before)
  })
  it('refuses a replacement payment intent after the first command', async () => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    await f.bridge.forward(request('/api/checkout/pay', { orderId, method: 'tarjeta' }))
    const before = f.dispatch.mock.calls.length
    await expect(
      f.bridge.forward(
        request('/api/checkout/pay', { orderId, method: 'bizum' }, '44444444-4444-4444-8444-444444444444')
      )
    ).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(before)
  })
  it('permits only an identical explicit payment retry and rechecks durable state each time', async () => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    const body = { orderId, method: 'tarjeta' }
    await f.bridge.forward(request('/api/checkout/pay', body))
    await f.bridge.forward(request('/api/checkout/pay', body))
    expect(f.bridge.proof.paymentPosts).toBe(2)
    expect(f.bridge.proof.paymentBody).toEqual(body)
    expect(f.bridge.proof.paymentKey).toBe(key)
    expect(f.readPayment).toHaveBeenCalledTimes(2)
  })
  it('does not report a payment as accepted when its durable readback fails', async () => {
    const f = fixture()
    await f.bridge.forward(request('/api/orders', { cartId: 'synthetic-cart' }))
    f.readPayment.mockRejectedValueOnce(new Error('payment not committed'))
    await expect(f.bridge.forward(request('/api/checkout/pay', { orderId, method: 'tarjeta' }))).rejects.toThrow(
      'payment not committed'
    )
    expect(f.bridge.proof.paymentPosts).toBe(0)
  })
})
