import { describe, expect, it, vi } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import {
  cartRecoveryIntentHash,
  cartRecoveryReceiptSchema,
  cartRecoveryResolvedSchema,
  type CartRecoveryReceipt
} from '../../shared/cart-recovery'
import {
  auditNativeCartRecoveryBrowser,
  createCartRecoveryBrowserBridge,
  type CartRecoveryBrowserFixture
} from '../../scripts/lib/audit-native-cart-recovery-browser'

const data = deterministicTestData('cart-recovery-browser-boundary'),
  origin = 'https://shop-audit.neteco.test',
  root = '/api/account/cart-recovery'
const prepared: CartRecoveryBrowserFixture = {
  customerCookie: 'neteco-session=synthetic-browser-boundary',
  capability: { id: data.uuid('association'), token: 'cr1.' + 'a'.repeat(64) },
  cartId: data.uuid('cart'),
  cartVersion: 2
}
const body = { ...prepared.capability, expectedCartVersion: prepared.cartVersion },
  key = data.uuid('resume')
function request(path: string, input?: unknown) {
  return new Request(origin + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      cookie: prepared.customerCookie,
      origin,
      'content-type': 'application/json',
      'idempotency-key': key
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  })
}
async function receipt(): Promise<CartRecoveryReceipt> {
  return cartRecoveryReceiptSchema.parse({
    source: 'cloudflare',
    commandId: key,
    action: 'resume',
    payloadHash: await cartRecoveryIntentHash('resume', body),
    version: 3,
    associationId: prepared.capability.id,
    cartVersion: 3,
    recoveryEnabled: true,
    recordedAt: '2026-10-10T12:00:00Z',
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
}
// Synthetic responses below test the bridge contract only. Real D1/CartDO,
// compiled SSR and connected Chromium must be supplied by ROOT integration.
describe('cart recovery browser bridge boundary (not browser acceptance)', () => {
  it('forwards only the owned exact capabilities GET with original customer cookies and no resume proof', async () => {
    const cookie = prepared.customerCookie + '; neteco-consent=necessary; neteco-cart-v2=synthetic-current',
      response = { source: 'cloudflare', state: 'ready', permissions: [] },
      dispatch = vi.fn(async (_request: Request) => Response.json(response)),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    const current = new Request(origin + '/api/admin/capabilities', { headers: { cookie } })
    const result = await bridge.forward(current)
    expect(result.action).toBe('fulfill')
    if (result.action === 'fulfill') expect(await result.response.json()).toEqual(response)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(current)
    expect(dispatch.mock.calls[0]![0].headers.get('cookie')).toBe(cookie)
    expect(readCommittedResume).not.toHaveBeenCalled()
    expect(bridge.counts.resumePosts).toBe(0)
  })
  it.each([
    { path: '/api/admin/capabilities', cookie: '' },
    { path: '/api/admin/capabilities', cookie: 'neteco-session=other-owner' },
    { path: '/api/admin/capabilities', cookie: prepared.customerCookie + '; neteco-session=other-owner' },
    { path: '/api/admin/capabilities?refresh=1' },
    { path: '/api/admin/capabilities', method: 'HEAD' },
    { path: '/api/admin/capabilities', method: 'POST' },
    { path: '/api/admin/capabilities', targetOrigin: 'https://outside.invalid' },
    { path: '/api/admin/%63apabilities' },
    { path: '/api/admin/capabilities/child' }
  ])('rejects non-exact or foreign capabilities transport before dispatch: %j', async (input) => {
    const dispatch = vi.fn(),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    const current = new Request((input.targetOrigin ?? origin) + input.path, {
      method: input.method ?? 'GET',
      headers: { cookie: input.cookie ?? prepared.customerCookie }
    })
    expect((await bridge.forward(current)).action).toBe('abort')
    expect(dispatch).not.toHaveBeenCalled()
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it.each(['/api/admin/orders', '/api/account/private'])(
    'blocks unowned private reads of %s before dispatch even with the customer cookie',
    async (path) => {
      const dispatch = vi.fn(async () => Response.json({ private: 'must never be read' })),
        readCommittedResume = vi.fn()
      const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
      expect((await bridge.forward(request(path))).action).toBe('abort')
      expect(dispatch).not.toHaveBeenCalled()
      expect(readCommittedResume).not.toHaveBeenCalled()
    }
  )
  it('sanitizes a browser transport exception containing a capability without retaining its cause', async () => {
    const newContext = vi.fn(async () => {
        throw new Error(origin + '/cuenta/recuperar-carrito#' + new URLSearchParams(prepared.capability))
      }),
      prepare = vi.fn(async () => prepared),
      dispatch = vi.fn()
    const failure: unknown = await auditNativeCartRecoveryBrowser({
      origin,
      browser: { newContext },
      prepare,
      dispatch,
      readCommittedResume: vi.fn(),
      revokeCapability: vi.fn(),
      assertEconomicUnchanged: vi.fn()
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'CartRecoveryBrowserError', stage: 'context', viewport: 'desktop' })
    expect(String(failure)).not.toContain(prepared.capability.token)
    expect(failure).not.toHaveProperty('cause')
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('forwards exact resume once and proves commit only after a valid HttpOnly possession grant', async () => {
    const value = await receipt(),
      readCommittedResume = vi.fn(async () => {})
    const dispatch = vi.fn(async (_request: Request) =>
      Response.json(value, {
        status: 201,
        headers: {
          'set-cookie': `neteco-cart-v2=v1.${prepared.cartId}.${'b'.repeat(43)}; HttpOnly; Secure; SameSite=Lax; Path=/`
        }
      })
    )
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    const result = await bridge.forward(request(root + '/resume', body))
    expect(result.action).toBe('fulfill')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await dispatch.mock.calls[0]![0]!.clone().json()).toEqual(body)
    expect(readCommittedResume).toHaveBeenCalledExactlyOnceWith({ body, receipt: value })
    await expect(bridge.forward(request(root + '/resume', body))).rejects.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects a successful-looking receipt without HttpOnly grant before independent commit proof', async () => {
    const dispatch = vi.fn(async () => Response.json(await receipt(), { status: 201 })),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    await expect(bridge.forward(request(root + '/resume', body))).rejects.toThrow('unconfirmed_possession_grant')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it.each([
    `neteco-cart-v2=v1.${data.uuid('wrong-cart')}.${'b'.repeat(43)}; HttpOnly; Secure; SameSite=Lax; Path=/`,
    `neteco-cart-v2=v1.${prepared.cartId}.${'b'.repeat(43)}; HttpOnly; SameSite=Lax; Path=/`
  ])('rejects a wrong-cart or insecure possession grant before independent proof', async (grant) => {
    const dispatch = vi.fn(async () =>
        Response.json(await receipt(), { status: 201, headers: { 'set-cookie': grant } })
      ),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    await expect(bridge.forward(request(root + '/resume', body))).rejects.toThrow('unconfirmed_possession_grant')
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it('blocks capability query leakage and external transport before dispatch', async () => {
    const dispatch = vi.fn(),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    expect((await bridge.forward(request(root + '/resolve?token=' + prepared.capability.token))).action).toBe('abort')
    expect((await bridge.forward(new Request('https://outside.invalid/collect'))).action).toBe('abort')
    expect(dispatch).not.toHaveBeenCalled()
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it('preserves revoked-capability denial without manufacturing receipt or retrying a mutation', async () => {
    const dispatch = vi.fn(async () => Response.json({ error: 'recovery_unavailable' }, { status: 404 })),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    const result = await bridge.forward(request(root + '/resolve', prepared.capability))
    expect(result.action).toBe('fulfill')
    if (result.action === 'fulfill') expect(result.response.status).toBe(404)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it('preserves the browser current rotated cart cookie on fresh cart GET instead of injecting an old grant', async () => {
    const rotatedCookie = prepared.customerCookie + '; neteco-cart-v2=v1.synthetic-rotated-grant'
    const dispatch = vi.fn(async (_request: Request) => Response.json({ unavailable: 'boundary-only' })),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    const current = new Request(origin + '/api/cart', { headers: { cookie: rotatedCookie } })
    expect((await bridge.forward(current)).action).toBe('fulfill')
    expect(dispatch.mock.calls[0]![0]!.headers.get('cookie')).toBe(rotatedCookie)
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
  it('does not present another cart resolved successfully as the canonical recovery snapshot', async () => {
    const canonical = cartRecoveryResolvedSchema.parse({
      source: 'cloudflare',
      associationId: prepared.capability.id,
      cartId: prepared.cartId,
      stage: 'checkout',
      cartVersion: prepared.cartVersion,
      expiresAt: '2026-10-11T12:00:00Z',
      evaluatedAt: '2026-10-10T12:00:00Z',
      inventoryEffect: 'none',
      economicEffect: 'none',
      lines: [
        {
          variantId: 11,
          quantity: 2,
          name: 'Synthetic boundary item',
          sku: 'SYNTHETIC',
          unitGrossCents: 500,
          netCents: 826,
          taxCents: 174,
          grossCents: 1000
        }
      ]
    })
    const dispatch = vi.fn(async () => Response.json(canonical)),
      readCommittedResume = vi.fn()
    const bridge = createCartRecoveryBrowserBridge({ origin, fixture: prepared, dispatch, readCommittedResume })
    expect((await bridge.forward(request(root + '/resolve', prepared.capability))).action).toBe('fulfill')
    dispatch.mockImplementation(async () =>
      Response.json(cartRecoveryResolvedSchema.parse({ ...canonical, cartId: data.uuid('foreign-cart') }))
    )
    await expect(bridge.forward(request(root + '/resolve', prepared.capability))).rejects.toThrow(
      'unconfirmed_recovery_snapshot'
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(readCommittedResume).not.toHaveBeenCalled()
  })
})
