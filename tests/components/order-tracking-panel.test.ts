import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderTrackingPanel from '../../app/components/OrderTrackingPanel.vue'
import type { OrderTrackingAudience } from '../../shared/order-tracking'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const ORDER = 'a1000000-0000-4000-8000-000000000070',
  OTHER = 'a1000000-0000-4000-8000-000000000071',
  TIME = '2026-10-09T12:00:00Z'
function fixture(audience: OrderTrackingAudience = 'customer') {
  return {
    source: 'cloudflare',
    orderId: ORDER,
    audience,
    shippingMethod: 'parcel',
    fulfillment: { state: 'packed', version: 2, updatedAt: TIME },
    packing: { parcelCount: 1, recordedAt: TIME },
    shipments: [
      {
        parcelIndex: 0,
        carrier: 'Operador externo',
        trackingNumber: 'MANUAL-70',
        recordedAt: TIME,
        verification: 'manual_unverified'
      }
    ],
    carrierEvents: [],
    carrierStatus: 'not_connected',
    fallback: { kind: 'contact_neteco', contactPath: '/contacto' },
    evaluatedAt: TIME
  }
}
const wrappers: Array<{ unmount(): void }> = []
beforeEach(() => mocks.request.mockReset().mockResolvedValue(fixture()))
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
async function render(patch: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(OrderTrackingPanel, {
    props: {
      orderId: ORDER,
      audience: 'customer',
      scopeKey: 'private-session:1',
      enabled: true,
      pending: false,
      ...patch
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
describe('private read-only operational order tracking', () => {
  it.each(['customer', 'admin', 'guest'] as const)(
    'reads the exact %s resource using request-scoped fetch and no mutations',
    async (audience) => {
      mocks.request.mockResolvedValue(fixture(audience))
      const wrapper = await render({ audience })
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
        `/api/${audience === 'admin' ? 'admin/' : ''}orders/${ORDER}/tracking`,
        expect.objectContaining({ method: 'GET', retry: 0, cache: 'no-store', signal: expect.any(AbortSignal) })
      )
      expect(wrapper.text()).toContain('MANUAL-70')
      expect(wrapper.text()).toContain('Referencia manual no verificada')
      expect(wrapper.text()).toContain('Seguimiento del transportista no conectado')
      expect(wrapper.findAll('a').map((link) => link.attributes('href'))).toEqual(['/contacto'])
    }
  )
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }, { orderId: 'bad' }])(
    'does not read without confirmed props %#',
    async (patch) => {
      const wrapper = await render(patch)
      expect(mocks.request).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('MANUAL-70')
    }
  )
  it.each([
    ['pending', 'Pendiente de preparación'],
    ['picking', 'En preparación'],
    ['packed', 'Embalado'],
    ['ready_for_pickup', 'Listo para recoger'],
    ['in_transit', 'En reparto'],
    ['delivered', 'Entregado'],
    ['exception', 'Incidencia operativa']
  ])('renders confirmed operational state %s, not a transport-provider claim', async (state, label) => {
    mocks.request.mockResolvedValue({
      ...fixture(),
      ...(state === 'ready_for_pickup' ? { shippingMethod: 'pickup', shipments: [] } : {}),
      fulfillment: { state, version: state === 'pending' ? 0 : 2, updatedAt: state === 'pending' ? null : TIME }
    })
    const wrapper = await render()
    expect(wrapper.text()).toContain(label)
    expect(wrapper.text()).toContain('no acredita aceptación ni eventos del transportista')
  })
  it('never infers transit from manually recorded tracking while fulfillment remains packed', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('Embalado')
    expect(wrapper.text()).not.toContain('En reparto')
    expect(wrapper.text()).not.toContain('Entregado')
  })
  it('renders carrier and tracking as escaped text, never links or HTML', async () => {
    mocks.request.mockResolvedValue({
      ...fixture(),
      shipments: [
        { ...fixture().shipments[0], carrier: '<img src=x>', trackingNumber: 'https://example.invalid/?private=1' }
      ]
    })
    const wrapper = await render()
    expect(wrapper.text()).toContain('<img src=x>')
    expect(wrapper.text()).toContain('https://example.invalid/?private=1')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.findAll('a').map((link) => link.attributes('href'))).toEqual(['/contacto'])
  })
  it.each(['wrong-order', 'wrong-audience', 'extra-private-field', 'invalid'])(
    'fails closed on %s instead of rendering stale/private data',
    async (boundary) => {
      const data = fixture()
      mocks.request.mockResolvedValue(
        boundary === 'wrong-order'
          ? { ...data, orderId: OTHER }
          : boundary === 'wrong-audience'
            ? { ...data, audience: 'admin' }
            : boundary === 'extra-private-field'
              ? { ...data, privateNote: 'Never reveal' }
              : { source: 'cloudflare' }
      )
      const wrapper = await render()
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(wrapper.text()).not.toMatch(/MANUAL-70|Never reveal/)
    }
  )
  it('single-flights manual refresh, clears old facts while loading and never polls or posts', async () => {
    const wrapper = await render(),
      pending = deferred<ReturnType<typeof fixture>>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const button = wrapper.get('[data-testid="order-tracking-refresh"]')
    await button.trigger('click')
    await button.trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('MANUAL-70')
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    pending.resolve(fixture())
    await flushPromises()
    expect(wrapper.text()).toContain('MANUAL-70')
    expect(mocks.request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })
  it.each([401, 403, 503])(
    'a %s refresh removes old facts and shows an error, not empty tracking',
    async (statusCode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'Private infrastructure details' })
      await wrapper.get('[data-testid="order-tracking-refresh"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(wrapper.text()).not.toMatch(/MANUAL-70|Private infrastructure details/)
      expect(mocks.request).toHaveBeenCalledTimes(2)
    }
  )
  it.each([
    { enabled: false },
    { pending: true },
    { scopeKey: 'other-session:2' },
    { orderId: OTHER },
    { audience: 'admin' }
  ])('aborts and purges before accepting an old response after boundary %#', async (patch) => {
    const pending = deferred<ReturnType<typeof fixture>>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    const signal = mocks.request.mock.calls[0]![1].signal as AbortSignal
    await wrapper.setProps(patch)
    pending.resolve(fixture())
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(wrapper.text()).not.toContain('MANUAL-70')
  })
  it('aborts its own request on unmount', async () => {
    mocks.request.mockReturnValueOnce(new Promise(() => undefined))
    const wrapper = await render(),
      signal = mocks.request.mock.calls[0]![1].signal as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })
  it('shows honest lack of connected events and confirmed absence of parcel records', async () => {
    mocks.request.mockResolvedValue({
      ...fixture(),
      shippingMethod: 'pickup',
      fulfillment: { state: 'pending', version: 0, updatedAt: null },
      packing: { parcelCount: 0, recordedAt: null },
      shipments: []
    })
    const wrapper = await render()
    expect(wrapper.text()).toContain('Recogida en almacén')
    expect(wrapper.text()).toContain('No hay bultos registrados')
    expect(wrapper.text()).toContain('Seguimiento del transportista no conectado')
    expect(wrapper.text()).not.toContain('En reparto')
  })
})
