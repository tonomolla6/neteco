import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditNativeQuickOrderBrowser,
  createQuickOrderBrowserBridge
} from '../../scripts/lib/audit-native-quick-order-browser'
const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicit_not_run'
}))
const origin = 'https://shop-audit.neteco.test',
  cartId = '71000000-0000-4000-8000-000000000001',
  key = '72000000-0000-4000-8000-000000000001',
  cookie = 'neteco-cart-v2=synthetic'
const body = { variantId: 11, quantity: 6, expectedVersion: 1, idempotencyKey: key }
const cart = () => ({ id: cartId, version: 2, items: [{ variantId: 11, qty: 6 }] })
function request(payload = body, headers = {}) {
  return new Request(origin + '/api/cart/items', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Neteco-Cart-Id': cartId,
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(payload)
  })
}
function fixture() {
  const dispatch = vi.fn(async () => Response.json(cart())),
    readCommitted = vi.fn(async () => undefined)
  return {
    dispatch,
    readCommitted,
    bridge: createQuickOrderBrowserBridge({
      origin,
      cartId,
      cartCookie: cookie,
      initialVersion: 1,
      variantLegacyId: 11,
      quantity: 6,
      dispatch,
      readCommitted
    })
  }
}
beforeEach(() => connect.mockReset())
describe('quick order browser bridge contract, not compiled/browser acceptance', () => {
  it('requires a correlated fresh cart GET after manual receipt, not just cleared browser storage', async () => {
    const f = fixture()
    await f.bridge.forward(request())
    f.dispatch.mockResolvedValue(
      Response.json({ source: 'cloudflare', cartId, commandId: key, outcome: 'applied', appliedVersion: 2 })
    )
    await f.bridge.forward(
      new Request(`${origin}/api/cart/operations/${key}?variantId=11&quantity=6&expectedVersion=1`)
    )
    f.dispatch.mockResolvedValue(Response.json({ ...cart(), version: 1 }))
    await expect(f.bridge.forward(new Request(origin + '/api/cart'))).rejects.toThrow()
    f.dispatch.mockResolvedValue(Response.json(cart()))
    await f.bridge.forward(new Request(origin + '/api/cart'))
    expect(f.bridge.proof).toMatchObject({ currentCartGets: 1 })
  })
  it('accepts the real CMP cookie alongside the exact frozen cart cookie', async () => {
    const f = fixture()
    expect(await f.bridge.forward(request(body, { Cookie: `neteco-consent-v1=necessary; ${cookie}` }))).toMatchObject({
      action: 'abort',
      reason: 'proven_quick_order_response_lost'
    })
    expect(f.readCommitted).toHaveBeenCalledOnce()
  })
  it('claims one ADD synchronously before parsing concurrent doubleclick requests', async () => {
    const f = fixture()
    const results = await Promise.allSettled([f.bridge.forward(request()), f.bridge.forward(request())])
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.bridge.proof.posts).toBe(1)
  })
  it('NOTRUN connects/prepares/dispatches/queries/emits no scenario', async () => {
    const dispatch = vi.fn(),
      prepareQuickOrder = vi.fn(),
      scenario = vi.fn(),
      prepare = vi.fn()
    expect(
      await auditNativeQuickOrderBrowser({
        origin,
        dispatch,
        prepareQuickOrder,
        scenario,
        database: { prepare } as unknown as D1Database,
        browserMode: 'not-run'
      })
    ).toMatchObject({ scenarios: 0, browserExecuted: false, productionBrowserAcceptance: false })
    for (const fn of [dispatch, prepareQuickOrder, scenario, prepare, connect]) expect(fn).not.toHaveBeenCalled()
  })
  it.each([
    'https://neteco.es',
    'http://shop-audit.neteco.test',
    'https://shop-audit.neteco.test/path',
    'https://user:secret@shop-audit.neteco.test'
  ])('rejects unsafe origin %s before any effect', async (origin) => {
    const dispatch = vi.fn(),
      prepareQuickOrder = vi.fn()
    await expect(
      auditNativeQuickOrderBrowser({
        origin,
        dispatch,
        prepareQuickOrder,
        database: {} as D1Database,
        browserMode: 'not-run'
      })
    ).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
    expect(prepareQuickOrder).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
  it.each(['id', 'version', 'variant', 'quantity'] as const)(
    'rejects incorrectly correlated successful ADD %s before claiming lost response',
    async (field) => {
      const f = fixture(),
        value = cart()
      if (field === 'id') value.id = key
      if (field === 'version') value.version = 3
      if (field === 'variant') value.items[0]!.variantId = 12
      if (field === 'quantity') value.items[0]!.qty = 7
      f.dispatch.mockResolvedValue(Response.json(value))
      await expect(f.bridge.forward(request())).rejects.toThrow()
      expect(f.bridge.proof.lostResponses).toBe(0)
      expect(f.readCommitted).not.toHaveBeenCalled()
    }
  )
  it('never loses response before independent ledger/HTTP receipt/current cart proof', async () => {
    const f = fixture()
    f.readCommitted.mockRejectedValue(new Error('ledger_missing'))
    await expect(f.bridge.forward(request())).rejects.toThrow('ledger_missing')
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it.each([201, 400, 401, 409, 429, 503])('does not claim commit/loss for HTTP%s', async (status) => {
    const f = fixture()
    f.dispatch.mockResolvedValue(Response.json({ error: { code: 'unavailable' } }, { status }))
    expect((await f.bridge.forward(request())).action).toBe('fulfill')
    expect(f.bridge.proof.lostResponses).toBe(0)
    expect(f.readCommitted).not.toHaveBeenCalled()
  })
  it('loses one proven200, blocks doubleclick/remaining ADD, forwards manual matching receipt GET', async () => {
    const f = fixture()
    expect(await f.bridge.forward(request())).toMatchObject({
      action: 'abort',
      reason: 'proven_quick_order_response_lost'
    })
    expect(f.readCommitted).toHaveBeenCalledExactlyOnceWith({ body, cart: cart() })
    await expect(f.bridge.forward(request())).rejects.toThrow()
    await expect(f.bridge.forward(request({ ...body, variantId: 12, idempotencyKey: cartId }))).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledOnce()
    const receipt = { source: 'cloudflare', cartId, commandId: key, outcome: 'applied', appliedVersion: 2 }
    f.dispatch.mockResolvedValue(Response.json(receipt))
    const query = new URLSearchParams({ variantId: '11', quantity: '6', expectedVersion: '1' })
    expect((await f.bridge.forward(new Request(`${origin}/api/cart/operations/${key}?${query}`))).action).toBe(
      'fulfill'
    )
    expect(f.bridge.proof).toMatchObject({ posts: 1, lostResponses: 1, receiptGets: 1 })
  })
  it.each(['cookie', 'cart-header', 'quantity', 'key', 'extra-body'] as const)(
    'rejects invalid frozen ADD %s before dispatch',
    async (field) => {
      const f = fixture()
      const payload =
        field === 'quantity'
          ? { ...body, quantity: 7 }
          : field === 'key'
            ? { ...body, idempotencyKey: 'bad' }
            : field === 'extra-body'
              ? { ...body, action: 'invented' }
              : body
      const headers =
        field === 'cookie'
          ? { Cookie: 'neteco-cart-v2=other' }
          : field === 'cart-header'
            ? { 'X-Neteco-Cart-Id': key }
            : {}
      await expect(f.bridge.forward(request(payload, headers))).rejects.toThrow()
      expect(f.dispatch).not.toHaveBeenCalled()
    }
  )
  it('blocks all external/extra business writes; only synthetic analytics DELETE remains permitted', async () => {
    const f = fixture()
    for (const req of [
      new Request('https://external.invalid/'),
      new Request(origin + '/api/orders', { method: 'POST' }),
      new Request(origin + '/api/cart/items/11', { method: 'PUT' })
    ])
      expect((await f.bridge.forward(req)).action).toBe('abort')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect((await f.bridge.forward(new Request(origin + '/api/analytics/session', { method: 'DELETE' }))).action).toBe(
      'fulfill'
    )
    expect(f.dispatch).toHaveBeenCalledOnce()
  })
  it('rejects mismatched manual receipt before counting recovery', async () => {
    const f = fixture()
    await f.bridge.forward(request())
    f.dispatch.mockResolvedValue(
      Response.json({ source: 'cloudflare', cartId: key, commandId: key, outcome: 'applied', appliedVersion: 2 })
    )
    await expect(
      f.bridge.forward(new Request(`${origin}/api/cart/operations/${key}?variantId=11&quantity=6&expectedVersion=1`))
    ).rejects.toThrow()
    expect(f.bridge.proof.receiptGets).toBe(0)
  })
})
