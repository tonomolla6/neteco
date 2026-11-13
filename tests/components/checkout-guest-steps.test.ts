import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutPage from '../../app/pages/checkout.vue'
import type { CartItem } from '../../app/stores/cart'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, runtimeMock, navigateMock, auth } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  navigateMock: vi.fn(),
  auth: { loggedIn: false },
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: {
      freeShippingThresholdCents: 0,
      priceDisplayMode: 'gross',
      serverRuntime: 'node',
      commercial: {},
      legalTermsUrl: 'https://neteco.es/legal'
    } as Record<string, unknown>
  }))
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('navigateTo', () => navigateMock)
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(auth.loggedIn),
  user: ref(
    auth.loggedIn
      ? { id: 'u', name: 'Ana Pérez', email: 'ana@example.invalid', phone: '600000000', company: 'Bar Central' }
      : null
  ),
  session: ref(null),
  clear: async () => undefined
}))

const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const item: CartItem = {
  productId: 1,
  variantId: 11,
  slug: 'producto',
  name: 'Producto sintético',
  brand: 'NETECO',
  format: '1 L',
  sku: 'S-11',
  price: 1210,
  netPrice: 1000,
  qty: 2,
  visual: { type: 'garrafa', color: '#123456' }
}
const serverCart = (items: CartItem[]) => ({
  id: 'synthetic-cart',
  version: 2,
  status: 'active',
  expiresAt: '2026-10-01T00:00:00Z',
  items,
  count: items.length,
  subtotal: items.length ? 2420 : 0,
  subtotalNet: items.length ? 2000 : 0,
  tax: items.length ? 420 : 0
})
let cartItems: CartItem[]
let addresses: unknown[]
type Mounted = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Mounted | undefined
async function render() {
  wrapper = await mountSuspended(CheckoutPage, {
    route: false,
    global: { stubs: { ClientOnly: Slot, ProductImage: true, CartRecoverySection: true } }
  })
  await flushPromises()
  await nextTick()
  return wrapper
}
beforeEach(() => {
  auth.loggedIn = false
  cartItems = [item]
  addresses = []
  navigateMock.mockReset()
  fetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return { orderId: null }
    if (path === '/api/cart') return serverCart(cartItems)
    if (path === '/api/account/addresses') return { addresses }
    throw Object.assign(new Error('Unexpected request: ' + path), { statusCode: 404 })
  })
  localStorage.clear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const visible = (selector: string) => !(wrapper!.get(selector).attributes('style') ?? '').includes('display: none')
const state = () => proxyRefs(wrapper!.setupState) as Record<string, unknown>
const fill = () => {
  const s = state()
  Object.assign(s.form as Record<string, string>, {
    name: 'Ana Pérez',
    email: 'ana@example.invalid',
    phone: '600000000'
  })
  Object.assign(s.shippingAddress as Record<string, string>, {
    recipientName: 'Ana Pérez',
    phone: '600000000',
    line1: 'C/ Mayor 12',
    postalCode: '46870',
    city: 'Ontinyent'
  })
}

describe('guest checkout in four steps', () => {
  it('shows delivery, billing, payment and shipment as four explicit steps', async () => {
    await render()
    const steps = wrapper!.findAll('[data-checkout-step]')
    expect(steps.map((step) => step.attributes('data-checkout-step'))).toEqual([
      'entrega',
      'facturacion',
      'pago',
      'envio'
    ])
    expect(steps[0]!.text()).toContain('Dirección de entrega')
    expect(steps[1]!.text()).toContain('Dirección de facturación')
    expect(steps[2]!.text()).toContain('Pago')
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(true)
    expect(visible('[data-checkout-step="facturacion"] [data-step-body]')).toBe(false)
    expect(visible('[data-checkout-step="pago"] [data-step-body]')).toBe(false)
    expect(wrapper!.get('[data-checkout-step="entrega"]').attributes('aria-current')).toBe('step')
    // Contact and address come first; shipment choice remains in its own final step.
    const entrega = wrapper!.get('[data-checkout-step="entrega"]')
    expect(entrega.find('[data-checkout-contact-fields]').exists()).toBe(true)
    expect(entrega.find('[data-checkout-address-fields]').exists()).toBe(true)
    expect(wrapper!.get('[data-checkout-step="envio"]').find('[data-checkout-shipments]').exists()).toBe(true)
    expect(wrapper!.get('[data-checkout-step="facturacion"]').find('[data-invoice-choice]').exists()).toBe(true)
  })

  it('a guest buying with a ticket has at most 8 required fields', async () => {
    await render()
    ;(state().validate as () => boolean)()
    const missing = Object.entries(state().errors as Record<string, string>).filter(
      ([key, value]) => key !== 'terms' && value
    )
    expect(missing.length).toBeLessThanOrEqual(8)
  })

  it('does not leave the first step until its own fields are valid, and never blames the terms early', async () => {
    await render()
    await wrapper!.get('[data-checkout-step="entrega"] [data-step-continue]').trigger('click')
    const errors = state().errors as Record<string, string>
    expect(errors.email).toBe('Indica el email')
    expect(errors.terms).toBe('')
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(true)
    expect(visible('[data-checkout-step="facturacion"] [data-step-body]')).toBe(false)
  })

  it('folds a completed step into one line with "Cambiar" and opens the next', async () => {
    await render()
    fill()
    await nextTick()
    await wrapper!.get('[data-checkout-step="entrega"] [data-step-continue]').trigger('click')
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(false)
    const summary = wrapper!.get('[data-checkout-step="entrega"] [data-step-summary]')
    expect(summary.text()).toContain('ana@example.invalid')
    expect(summary.text()).toContain('C/ Mayor 12, 46870 Ontinyent')
    expect(visible('[data-checkout-step="facturacion"] [data-step-body]')).toBe(true)
    expect(wrapper!.get('[data-checkout-step="facturacion"]').attributes('aria-current')).toBe('step')

    await wrapper!.get('[data-checkout-step="facturacion"] [data-step-continue]').trigger('click')
    expect(wrapper!.get('[data-checkout-step="facturacion"] [data-step-summary]').text()).toContain(
      'Ticket a mi nombre'
    )
    expect(visible('[data-checkout-step="pago"] [data-step-body]')).toBe(true)

    await wrapper!.get('[data-checkout-step="entrega"] [data-step-change]').trigger('click')
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(true)
    expect(visible('[data-checkout-step="pago"] [data-step-body]')).toBe(false)
  })

  it('reopens the step that holds the first error when the final payment is refused', async () => {
    await render()
    fill()
    await wrapper!.get('[data-checkout-step="entrega"] [data-step-continue]').trigger('click')
    await wrapper!.get('[data-checkout-step="facturacion"] [data-step-continue]').trigger('click')
    const s = state()
    ;(s.form as Record<string, string>).email = ''
    ;(s.validate as () => boolean)()
    ;(s.scrollToFirstError as () => void)()
    await nextTick()
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(true)
  })

  it('keeps every step open for a signed-in customer', async () => {
    auth.loggedIn = true
    await render()
    expect(visible('[data-checkout-step="entrega"] [data-step-body]')).toBe(true)
    expect(visible('[data-checkout-step="facturacion"] [data-step-body]')).toBe(true)
    expect(visible('[data-checkout-step="pago"] [data-step-body]')).toBe(true)
    expect(wrapper!.find('[data-step-continue]').exists()).toBe(false)
  })
})
