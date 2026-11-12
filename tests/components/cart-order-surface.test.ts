import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CartPage from '../../app/pages/carrito.vue'
import type { useCartStore, CartItem } from '../../app/stores/cart'
import { clearNuxtState } from '#app'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, runtimeMock, lazyMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: {
      freeShippingThresholdCents: 15000,
      priceDisplayMode: 'gross',
      serverRuntime: 'cloudflare',
      commercial: {}
    } as Record<string, unknown>
  })),
  lazyMock: vi.fn()
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useLazyFetch', () => lazyMock)
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined
}))

const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const items: CartItem[] = [
  {
    productId: 1,
    variantId: 11,
    slug: 'desengrasante-dg-5',
    name: 'Desengrasante DG-5',
    brand: 'NETECO',
    format: 'Garrafa 5 L',
    sku: '1042',
    price: 1186,
    netPrice: 980,
    taxRateBasisPoints: 2100,
    priceTiers: [{ minimumQuantity: 4, unitGrossCents: 1101 }],
    qty: 2,
    visual: { type: 'garrafa', color: '#123456' }
  },
  {
    productId: 2,
    variantId: 12,
    slug: 'guante-nitrilo',
    name: 'Guante nitrilo M',
    brand: 'NETECO',
    format: 'Caja 100',
    sku: '1133',
    price: 424,
    netPrice: 350,
    taxRateBasisPoints: 2100,
    qty: 4,
    visual: { type: 'caja', color: '#123456' }
  }
]
const serverCart = () => ({
  id: 'synthetic-cart',
  version: 2,
  status: 'active',
  expiresAt: '2026-10-01T00:00:00Z',
  items,
  count: 6,
  subtotal: 4068,
  subtotalNet: 3362,
  tax: 706
})
const rate = (overrides = {}) => ({
  serviceCode: 'own_delivery',
  label: 'Reparto propio',
  netCents: 0,
  taxRateBasisPoints: 2100,
  estimatedDeliveryFrom: '2026-11-19T08:00:00Z',
  estimatedDeliveryTo: '2026-11-19T18:00:00Z',
  etaStatus: 'estimated',
  profile: 'own_delivery',
  pricingVersion: 'v',
  subtotalNetCents: 3362,
  taxCents: 706,
  totalGrossCents: 4068,
  ...overrides
})

type Mounted = Awaited<ReturnType<typeof mountSuspended>>
type Store = ReturnType<typeof useCartStore>
let wrapper: Mounted | undefined
let runtime: 'cloudflare' | 'node'
let mode: 'gross' | 'net-and-gross'
async function render() {
  wrapper = await mountSuspended(CartPage, {
    route: false,
    global: {
      stubs: {
        ClientOnly: Slot,
        ProductImage: true,
        ReorderDialog: true,
        CartRecoverySection: { template: '<div data-recovery-section />' },
        CartSnapshotsPanel: { template: '<div data-snapshots-panel />' },
        PublishedProductRelations: { template: '<div data-cross-sell />' },
        CartAddByReference: { template: '<div data-add-by-reference />' }
      }
    }
  })
  await flushPromises()
  ;(proxyRefs(wrapper.setupState).cart as Store).apply(serverCart() as never)
  await nextTick()
  await flushPromises()
  return wrapper
}
const text = () => wrapper!.text().replace(/\s+/g, ' ')

beforeEach(() => {
  runtime = 'cloudflare'
  mode = 'gross'
  runtimeMock.mockImplementation(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { freeShippingThresholdCents: 15000, priceDisplayMode: mode, serverRuntime: runtime, commercial: {} }
  }))
  lazyMock.mockReturnValue({ data: ref({ orders: [] }), status: ref('success') })
  fetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/cart') return serverCart()
    if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate()] }
    throw new Error('Unexpected request: ' + path)
  })
  localStorage.clear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  localStorage.clear()
  clearNuxtState('delivery-destination')
})

describe('cart as the last ordering surface', () => {
  it('opens with adding by reference and the lines; recovery and cross-sell come after', async () => {
    await render()
    const html = wrapper!.html()
    const order = ['<h1', 'data-add-by-reference', 'data-cart-line', 'data-cross-sell'].map((marker) =>
      html.indexOf(marker)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html.indexOf('data-recovery-section')).toBeGreaterThan(html.indexOf('data-cart-line'))
    expect(html.indexOf('data-snapshots-panel')).toBeGreaterThan(html.indexOf('data-cart-line'))
  })

  it('each line shows its reference, unit price, the reachable volume tier and a worded remove', async () => {
    await render()
    const [first, second] = wrapper!.findAll('[data-cart-line]')
    const line = first!.text().replace(/\s+/g, ' ')
    expect(line).toContain('Ref. 1042')
    expect(line).toContain('Garrafa 5 L')
    expect(line).toContain('11,86 €/ud')
    expect(line).toContain('Con 2 más: 11,01 €/ud')
    expect(line).toContain('23,72 €')
    expect(first!.get('[data-cart-remove]').text()).toBe('Quitar')
    expect(second!.text()).not.toContain('más:')
    expect(first!.html()).not.toContain('font-mono')
  })

  it('breaks the total down into taxable base, VAT, shipping and total, in that order', async () => {
    await render()
    const rows = wrapper!
      .get('[data-cart-summary]')
      .findAll('dt')
      .map((term) => term.text().replace(/\s+/g, ' '))
    expect(rows[0]).toContain('Base imponible')
    expect(rows[1]).toContain('IVA')
    expect(rows[2]).toContain('Envío')
    expect(rows[3]).toBe('Total')
    const summary = wrapper!.get('[data-cart-summary]').text().replace(/\s+/g, ' ')
    expect(summary).toContain('33,62 €')
    expect(summary).toContain('7,06 €')
    expect(summary).toContain('40,68 €')
    expect(text()).not.toContain('Se calcula al tramitar')
  })

  it('asks for the destination once and then states method, cost and day', async () => {
    await render()
    const estimate = wrapper!.get('[data-shipping-estimate]')
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/shipping/rates')).toBe(false)
    await estimate.get('input[autocomplete="postal-code"]').setValue('46870')
    await estimate.get('input[autocomplete="address-level2"]').setValue('Ontinyent')
    await estimate.get('form').trigger('submit')
    await flushPromises()
    const call = fetchMock.mock.calls.find(([path]) => path === '/api/shipping/rates')!
    expect(call[1]).toMatchObject({ method: 'POST', body: { postalCode: '46870', city: 'Ontinyent' } })
    expect(call[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    const summary = wrapper!.get('[data-cart-summary]').text().replace(/\s+/g, ' ')
    expect(summary).toContain('Envío a 46870')
    expect(summary).toContain('gratis')
    expect(summary).toContain('Reparto propio')
    expect(summary).toMatch(/jueves,? 19/)
    expect(JSON.parse(localStorage.getItem('neteco-destination')!)).toEqual({ postalCode: '46870', city: 'Ontinyent' })
  })

  it('uses the remembered destination without asking and adds a paid shipping to the total', async () => {
    localStorage.setItem('neteco-destination', JSON.stringify({ postalCode: '28001', city: 'Madrid' }))
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/cart') return serverCart()
      return {
        cartVersion: 2,
        rates: [
          rate({
            serviceCode: 'parcel',
            label: 'Envío peninsular',
            profile: 'parcel',
            netCents: 488,
            totalGrossCents: 4658,
            estimatedDeliveryFrom: null,
            estimatedDeliveryTo: null,
            etaStatus: 'unknown'
          })
        ]
      }
    })
    await render()
    await flushPromises()
    const summary = wrapper!.get('[data-cart-summary]').text().replace(/\s+/g, ' ')
    expect(summary).toContain('Envío a 28001')
    expect(summary).toContain('5,90 €')
    expect(summary).toContain('46,58 €')
    expect(summary).toContain('Envío peninsular')
    expect(wrapper!.find('[data-shipping-estimate] input').exists()).toBe(false)
    expect(wrapper!.get('[data-shipping-change]').text()).toBe('Cambiar')
  })

  it('says plainly when shipping cannot be estimated yet, without inventing a figure', async () => {
    localStorage.setItem('neteco-destination', JSON.stringify({ postalCode: '46870', city: 'Ontinyent' }))
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/cart') return serverCart()
      throw Object.assign(new Error('unavailable'), { statusCode: 503 })
    })
    await render()
    await flushPromises()
    expect(wrapper!.get('[data-shipping-estimate]').text()).toContain('No hemos podido calcular el envío')
    expect(wrapper!.get('[data-cart-summary]').text().replace(/\s+/g, ' ')).toContain('40,68 €')
  })

  it('where the storefront needs the full address, it says the shipping comes in the next step', async () => {
    runtime = 'node'
    await render()
    expect(wrapper!.find('[data-shipping-estimate] input').exists()).toBe(false)
    expect(wrapper!.get('[data-cart-summary]').text()).toContain('Lo ves en el siguiente paso, antes de pagar')
  })

  it('keeps one checkout action per viewport: summary on desktop, fixed bar on mobile', async () => {
    await render()
    const links = wrapper!.findAll('a[href="/checkout"]')
    expect(links).toHaveLength(2)
    const bar = wrapper!.get('[data-cart-mobile-bar]')
    expect(bar.classes()).toContain('lg:hidden')
    expect(bar.text().replace(/\s+/g, ' ')).toContain('40,68 €')
    expect(bar.get('a[href="/checkout"]').text()).toContain('Tramitar pedido')
    const desktop = links.find((link) => !bar.element.contains(link.element))!
    expect(desktop.classes()).toContain('hidden')
    expect(desktop.classes()).toContain('lg:flex')
  })

  it('in net mode the main figures are net and the breakdown still ends in the payable total', async () => {
    mode = 'net-and-gross'
    await render()
    const line = wrapper!.findAll('[data-cart-line]')[0]!.text().replace(/\s+/g, ' ')
    expect(line).toContain('9,80 €/ud')
    expect(wrapper!.get('[data-cart-summary]').text().replace(/\s+/g, ' ')).toContain('40,68 €')
  })
})

describe('empty cart', () => {
  it('offers ordering by reference as well as the catalogue', async () => {
    fetchMock.mockImplementation(async () => ({
      ...serverCart(),
      items: [],
      count: 0,
      subtotal: 0,
      subtotalNet: 0,
      tax: 0
    }))
    wrapper = await mountSuspended(CartPage, {
      route: false,
      global: { stubs: { ClientOnly: Slot, ReorderDialog: true, CartRecoverySection: true, CartSnapshotsPanel: true } }
    })
    await flushPromises()
    ;(proxyRefs(wrapper.setupState).cart as Store).apply({
      ...serverCart(),
      items: [],
      count: 0,
      subtotal: 0,
      subtotalNet: 0,
      tax: 0
    } as never)
    await nextTick()
    expect(wrapper.find('a[href="/pedido-rapido"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/catalogo"]').exists()).toBe(true)
  })
})
