import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { readdirSync, readFileSync } from 'node:fs'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutPage from '../../app/pages/checkout.vue'
import CheckoutLayout from '../../app/layouts/checkout.vue'
import type { useCartStore, CartItem } from '../../app/stores/cart'
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

describe('checkout shell', () => {
  it('shows the configured contact phone instead of the email', async () => {
    const original = runtimeMock.getMockImplementation()!
    runtimeMock.mockImplementation(() => ({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: {
        freeShippingThresholdCents: 0,
        priceDisplayMode: 'gross',
        serverRuntime: 'node',
        commercial: { contactPhone: '960 111 222' },
        legalTermsUrl: 'https://neteco.es/legal'
      }
    }))
    try {
      const layout = await mountSuspended(CheckoutLayout, { slots: { default: '<p>contenido</p>' } })
      expect(layout.get('a[href="tel:960111222"]').text()).toContain('960 111 222')
      layout.unmount()
    } finally {
      runtimeMock.mockImplementation(original)
    }
  })

  it('uses a reduced layout: way back to the cart, secure payment and the phone, nothing else to leave by', async () => {
    const layout = await mountSuspended(CheckoutLayout, { slots: { default: '<p>contenido</p>' } })
    expect(layout.get('a[href="/carrito"]').attributes('aria-label')).toContain('Volver al carrito')
    expect(layout.text()).toContain('Pago seguro')
    // Sin teléfono configurado no se pinta ninguno: queda el correo único de la tienda.
    expect(layout.find('a[href^="tel:"]').exists()).toBe(false)
    expect(layout.get('a[href="mailto:tienda@neteco.es"]').text()).toContain('tienda@neteco.es')
    expect(layout.find('a[href="/catalogo"]').exists()).toBe(false)
    expect(layout.find('a[href^="/categoria"]').exists()).toBe(false)
    expect(layout.find('input[type="email"]').exists()).toBe(false)
    expect(layout.find('nav[aria-label="Accesos rápidos"]').exists()).toBe(false)
    expect(layout.get('main').attributes('id')).toBe('contenido-principal')
    expect(readFileSync('app/pages/checkout.vue', 'utf8')).toMatch(/definePageMeta\(\{[^}]*layout: 'checkout'/)
  })

  it('goes back to the cart when there is nothing to pay for', async () => {
    cartItems = []
    await render()
    expect(navigateMock).toHaveBeenCalledWith('/carrito', { replace: true })
  })

  it('stays on the page with a cart and shows the total in the first screen on mobile', async () => {
    await render()
    expect(navigateMock).not.toHaveBeenCalled()
    const top = wrapper!.get('[data-checkout-total-mobile]')
    expect(top.classes()).toContain('lg:hidden')
    expect(top.attributes('href')).toBe('#resumen-pedido')
    expect(top.text().replace(/\s+/g, ' ')).toContain('24,20 €')
    expect(wrapper!.find('#resumen-pedido').exists()).toBe(true)
    const html = wrapper!.html()
    expect(html.indexOf('data-checkout-total-mobile')).toBeLessThan(html.indexOf('Nombre y apellidos'))
  })

  it('speaks plainly about saved cards and has no all-caps subheadings', () => {
    const source = [
      'app/pages/checkout.vue',
      ...readdirSync('app/components/checkout').map((file) => `app/components/checkout/${file}`)
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(source).toContain('Guardar esta tarjeta para próximos pedidos')
    expect(source).not.toContain('referencia tokenizada')
    for (const heading of source.matchAll(/<h[1-6]\b[^>]*>/g)) expect(heading[0]).not.toMatch(/\buppercase\b/)
  })

  it('fills the delivery with the saved default address of a signed-in customer', async () => {
    auth.loggedIn = true
    addresses = [
      {
        id: 'a-2',
        kind: 'billing',
        label: 'Fiscal',
        recipientName: 'Bar Central S.L.',
        companyName: 'Bar Central S.L.',
        taxId: 'B12345678',
        line1: 'C/ Fiscal 1',
        line2: null,
        postalCode: '46001',
        city: 'València',
        region: 'Valencia',
        countryCode: 'ES',
        phone: null,
        instructions: null,
        isDefault: true
      },
      {
        id: 'a-1',
        kind: 'shipping',
        label: 'Bar',
        recipientName: 'Ana Pérez',
        companyName: 'Bar Central',
        taxId: null,
        line1: 'C/ Mayor 12',
        line2: 'Bajo',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES',
        phone: '611111111',
        instructions: 'Entrada por el callejón',
        isDefault: true
      }
    ]
    await render()
    await flushPromises()
    const shipping = (proxyRefs(wrapper!.setupState) as Record<string, Record<string, string>>).shippingAddress!
    expect(shipping).toMatchObject({
      line1: 'C/ Mayor 12',
      line2: 'Bajo',
      postalCode: '46870',
      city: 'Ontinyent',
      instructions: 'Entrada por el callejón'
    })
    expect(wrapper!.get('[data-checkout-prefilled]').text()).toContain('C/ Mayor 12, 46870 Ontinyent')
    expect((proxyRefs(wrapper!.setupState).cart as ReturnType<typeof useCartStore>).items).toHaveLength(1)
  })

  it('never overwrites what the customer has already typed', async () => {
    auth.loggedIn = true
    addresses = [
      {
        id: 'a-1',
        kind: 'both',
        label: 'Bar',
        recipientName: 'Ana Pérez',
        companyName: null,
        taxId: null,
        line1: 'C/ Mayor 12',
        line2: null,
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES',
        phone: null,
        instructions: null,
        isDefault: true
      }
    ]
    let release!: (value: unknown) => void
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/checkout/recover') return { orderId: null }
      if (path === '/api/cart') return serverCart(cartItems)
      if (path === '/api/account/addresses') return new Promise((resolve) => (release = resolve))
      throw Object.assign(new Error('Unexpected request: ' + path), { statusCode: 404 })
    })
    await render()
    const shipping = (proxyRefs(wrapper!.setupState) as Record<string, Record<string, string>>).shippingAddress!
    shipping.line1 = 'Otra dirección 5'
    release({ addresses })
    await flushPromises()
    expect(shipping.line1).toBe('Otra dirección 5')
    expect(shipping.postalCode).toBe('')
    expect(wrapper!.find('[data-checkout-prefilled]').exists()).toBe(false)
  })

  it('opens a one-screen review for a signed-in customer with saved data, with "Cambiar" instead of fields', async () => {
    auth.loggedIn = true
    addresses = [
      {
        id: 'a-1',
        kind: 'shipping',
        label: 'Bar',
        recipientName: 'Ana Pérez',
        companyName: 'Bar Central',
        taxId: null,
        line1: 'C/ Mayor 12',
        line2: 'Bajo',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES',
        phone: '611111111',
        instructions: null,
        isDefault: true
      }
    ]
    await render()
    await flushPromises()
    const hidden = (selector: string) => (wrapper!.get(selector).attributes('style') ?? '').includes('display: none')
    const review = wrapper!.get('[data-checkout-review]')
    expect(review.text()).toContain('Ana Pérez · ana@example.invalid · 600000000')
    expect(review.text()).toContain('C/ Mayor 12, Bajo, 46870 Ontinyent')
    expect(hidden('[data-checkout-contact-fields]')).toBe(true)
    expect(hidden('[data-checkout-address-fields]')).toBe(true)
    await review.get('[data-review-change]').trigger('click')
    expect(wrapper!.find('[data-checkout-review]').exists()).toBe(false)
    expect(hidden('[data-checkout-contact-fields]')).toBe(false)
    expect(hidden('[data-checkout-address-fields]')).toBe(false)
  })

  it('a guest fills the fields: there is nothing to review', async () => {
    await render()
    expect(wrapper!.find('[data-checkout-review]').exists()).toBe(false)
    expect(wrapper!.get('[data-checkout-contact-fields]').attributes('style') ?? '').not.toContain('display: none')
  })

  it('a guest types the phone once: delivery reuses the contact phone and name until changed', async () => {
    await render()
    const state = proxyRefs(wrapper!.setupState) as Record<string, Record<string, string>>
    state.form!.name = 'Ana Pérez'
    state.form!.phone = '600000000'
    await nextTick()
    expect(state.shippingAddress!.recipientName).toBe('Ana Pérez')
    expect(state.shippingAddress!.phone).toBe('600000000')
    state.shippingAddress!.phone = '611111111'
    state.form!.phone = '622222222'
    await nextTick()
    expect(state.shippingAddress!.phone).toBe('611111111')
  })

  it('asks "ticket or company invoice" first; a company invoice requires company name and a valid NIF', async () => {
    await render()
    const state = proxyRefs(wrapper!.setupState) as Record<string, unknown>
    expect(wrapper!.get('[data-invoice-choice]').text()).toContain('Ticket a mi nombre')
    expect(wrapper!.get('[data-invoice-choice]').text()).toContain('Factura de empresa')
    expect(wrapper!.find('[data-invoice-fields]').exists()).toBe(false)
    await wrapper!.get('[data-invoice-choice] input[value="company"]').setValue(true)
    expect(wrapper!.find('[data-invoice-fields]').exists()).toBe(true)
    const form = state.form as Record<string, string>
    Object.assign(form, { name: 'Ana', email: 'ana@example.invalid', phone: '600000000', company: '', nif: '' })
    ;(state.validate as () => boolean)()
    const errors = state.errors as Record<string, string>
    expect(errors.company).toBe('Indica la razón social')
    expect(errors.nif).toBe('Indica el NIF o CIF para la factura')
    form.company = 'Bar Central S.L.'
    form.nif = 'B12345678X'
    ;(state.validate as () => boolean)()
    expect(errors.company).toBe('')
    expect(errors.nif).toBe('Revisa el NIF, NIE o CIF')
  })

  it('a ticket clears any company or NIF typed before, and a signed-in company starts with the invoice', async () => {
    await render()
    const state = proxyRefs(wrapper!.setupState) as Record<string, unknown>
    const form = state.form as Record<string, string>
    await wrapper!.get('[data-invoice-choice] input[value="company"]').setValue(true)
    form.company = 'Bar Central S.L.'
    form.nif = 'B12345674'
    await wrapper!.get('[data-invoice-choice] input[value="ticket"]').setValue(true)
    expect(form.company).toBe('')
    expect(form.nif).toBe('')
    wrapper!.unmount()
    auth.loggedIn = true
    await render()
    expect(proxyRefs(wrapper!.setupState).invoice).toBe('company')
  })
})
