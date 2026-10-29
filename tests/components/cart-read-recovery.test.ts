import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CartPage from '../../app/pages/carrito.vue'
import CheckoutPage from '../../app/pages/checkout.vue'
import ShippingPage from '../../app/pages/envios.vue'
import type { useCartStore, CartItem } from '../../app/stores/cart'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, runtimeMock, lazyMock, trackMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { freeShippingThresholdCents: 15000 as unknown, priceDisplayMode: 'gross', serverRuntime: 'cloudflare' }
  })),
  lazyMock: vi.fn(),
  trackMock: vi.fn(async () => undefined)
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useLazyFetch', () => lazyMock)
mockNuxtImport('useAnalytics', () => () => ({ track: trackMock }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))

const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean, to: String },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        props.to ? 'a' : 'button',
        {
          ...attrs,
          href: props.to,
          type: props.to ? undefined : (attrs.type ?? 'button'),
          disabled: props.disabled || props.loading
        },
        slots.default?.()
      )
})
const item: CartItem = {
  productId: 1,
  variantId: 11,
  slug: 'synthetic-product',
  name: 'Producto sintético',
  brand: 'NETECO',
  format: '1 L',
  sku: 'SYNTHETIC-11',
  price: 15000,
  netPrice: 12397,
  qty: 1,
  visual: { type: 'garrafa', color: '#123456' }
}
type Mounted = Awaited<ReturnType<typeof mountSuspended>>
type Store = ReturnType<typeof useCartStore>
let wrapper: Mounted | undefined
let threshold: unknown
const serverCart = (items: CartItem[] = []) => ({
  id: 'synthetic-cart',
  version: 2,
  status: 'active',
  expiresAt: '2026-10-01T00:00:00Z',
  items,
  count: items.length,
  subtotal: items.length ? 15000 : 0,
  subtotalNet: items.length ? 12397 : 0,
  tax: items.length ? 2603 : 0
})
function state() {
  return proxyRefs(wrapper!.setupState) as Record<string, unknown>
}
function cart() {
  return state().cart as Store
}
async function render(component: typeof CartPage | typeof CheckoutPage | typeof ShippingPage) {
  wrapper = await mountSuspended(component, {
    route: false,
    global: {
      stubs: {
        ClientOnly: Slot,
        UButton: Button,
        UIcon: true,
        ProductImage: true,
        ReorderDialog: true,
        CartLineControls: true,
        NuxtLink: Slot
      }
    }
  })
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  threshold = 15000
  runtimeMock.mockImplementation(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { freeShippingThresholdCents: threshold, priceDisplayMode: 'gross', serverRuntime: 'cloudflare' }
  }))
  lazyMock.mockReturnValue({ data: ref({ orders: [] }), status: ref('success') })
  fetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return { orderId: null }
    if (path === '/api/cart') return serverCart()
    throw new Error('Unexpected request: ' + path)
  })
  localStorage.removeItem('neteco-cart-cache')
  localStorage.removeItem('neteco-cart')
  trackMock.mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe.each([
  { name: 'carrito', page: CartPage },
  { name: 'checkout', page: CheckoutPage }
])('cart read recovery: $name', ({ page }) => {
  it.each(['initial', 'pending', 'failure'] as const)('never presents %s as an empty cart', async (mode) => {
    await render(page)
    Object.assign(cart(), {
      items: [],
      ready: mode !== 'initial',
      loading: mode === 'pending',
      error: mode === 'failure' ? 'private SQL failure' : ''
    })
    await nextTick()
    expect(wrapper!.text()).not.toContain('Tu carrito está vacío')
    expect(wrapper!.html()).not.toContain('private SQL failure')
    if (mode === 'failure') expect(wrapper!.get('[role="alert"]').text()).toContain('No hemos podido consultar')
    else expect(wrapper!.get('[role="status"]').attributes('aria-busy')).toBe('true')
  })
  it('hides cached products and payment actions after a failed read', async () => {
    await render(page)
    Object.assign(cart(), { items: [item], ready: true, error: 'offline', loading: false })
    await nextTick()
    expect(wrapper!.text()).not.toContain(item.name)
    expect(wrapper!.find('form').exists()).toBe(false)
    expect(wrapper!.get('[role="alert"]').text()).toContain('Reintentar consulta')
  })
  it('retries only a GET, never restores cached items with new mutation keys', async () => {
    await render(page)
    Object.assign(cart(), { items: [item], ready: true, error: 'offline', loading: false })
    localStorage.setItem('neteco-cart', JSON.stringify([item]))
    fetchMock.mockClear()
    await nextTick()
    await wrapper!.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/cart')
    expect(cart().items).toEqual([])
    expect(cart().error).toBe('')
    expect(wrapper!.text()).toContain('Tu carrito está vacío')
  })
  it('blocks a cached concurrent retry callback and recovers confirmed products', async () => {
    await render(page)
    Object.assign(cart(), { items: [], ready: true, error: 'offline', loading: false })
    let resolve!: (value: ReturnType<typeof serverCart>) => void
    fetchMock.mockClear().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const retry = state().retryCartRead as () => Promise<void>
    const first = retry()
    await retry()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/cart')
    expect(wrapper!.get('[role="status"]').attributes('aria-busy')).toBe('true')
    resolve(serverCart([item]))
    await first
    await nextTick()
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper!.text()).not.toContain('Tu carrito está vacío')
  })
  it('keeps a repeated transport failure visible without reflecting server errors', async () => {
    await render(page)
    Object.assign(cart(), { items: [], ready: true, error: 'offline', loading: false })
    fetchMock.mockClear().mockRejectedValue(new Error('secret SQL error'))
    await (state().retryCartRead as () => Promise<void>)()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/cart')
    expect(wrapper!.get('[role="alert"]').text()).toContain('Reintentar consulta')
    expect(wrapper!.html()).not.toContain('secret SQL error')
    expect(wrapper!.text()).not.toContain('Tu carrito está vacío')
  })
})

describe('shipping threshold is not a contractual free-shipping promise', () => {
  it.each([14999, 15000, 15001])(
    'qualifies the cart message at subtotal %i regardless of pallet/ADR profile',
    async (subtotal) => {
      await render(CartPage)
      cart().apply(serverCart([item]))
      cart().serverTotals!.subtotal = subtotal
      await nextTick()
      expect(wrapper!.text()).toContain('paquetería estándar elegible')
      expect(wrapper!.text()).toContain('Sujeto a cotización')
      expect(wrapper!.text()).toContain('Palés y mercancías peligrosas no están incluidos')
      expect(wrapper!.text()).not.toContain('Envío por agencia gratis en este pedido')
      expect(Number(wrapper!.get('[role="progressbar"]').attributes('aria-valuenow'))).toBeLessThanOrEqual(100)
    }
  )
  it.each([0, -1, null, undefined, Infinity, NaN, 1.5, '150.5', 'Infinity', true, {}])(
    'hides invalid/disabled thresholds: %#',
    async (value) => {
      threshold = value
      await render(CartPage)
      cart().apply(serverCart([item]))
      await nextTick()
      expect(wrapper!.find('[role="progressbar"]').exists()).toBe(false)
      expect(wrapper!.text()).not.toContain('umbral de paquetería')
    }
  )
  it('qualifies the shared shipping-page label as eligible standard parcels subject to a quote', async () => {
    threshold = '15000'
    await render(ShippingPage)
    expect(wrapper!.text()).toContain('Paquetería estándar elegible gratis desde 150')
    expect(wrapper!.text()).toContain('sujeto a cotización')
  })
  it('does not bypass a checkout recovery failure with a cart retry', async () => {
    fetchMock.mockRejectedValue({ statusCode: 503 })
    await render(CheckoutPage)
    const initialCalls = fetchMock.mock.calls.length
    await (state().retryCartRead as () => Promise<void>)()
    expect(fetchMock).toHaveBeenCalledTimes(initialCalls)
    expect(wrapper!.text()).toContain('Recarga antes de volver a pagar')
    expect(wrapper!.find('form').exists()).toBe(false)
  })
  it('shows explicit ADD recovery actions and prevents checkout while its result is uncertain', async () => {
    await render(CartPage)
    cart().apply(serverCart([item]))
    fetchMock.mockImplementation(async (path, options) => {
      if ((options as { method?: string })?.method === 'POST') throw { statusCode: 500 }
      if (path === '/api/cart') return serverCart([item])
      return { orders: [] }
    })
    await cart()
      .add({ variantId: item.variantId }, 2)
      .catch(() => undefined)
    await nextTick()
    expect(wrapper!.text()).toContain('Comprobar adición')
    expect(wrapper!.text()).toContain('Reintentar la misma adición')
    expect(wrapper!.text()).toContain('No sabemos si se añadió el producto')
    expect(wrapper!.find('a[href="/checkout"]').exists()).toBe(false)
    expect(
      fetchMock.mock.calls.filter(([, options]) => (options as { method?: string })?.method === 'POST')
    ).toHaveLength(1)
  })
})
