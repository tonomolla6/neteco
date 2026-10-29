import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutPage from '../../app/pages/checkout.vue'
import type { useCartStore } from '../../app/stores/cart'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, navigateMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), navigateMock: vi.fn() }))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('navigateTo', () => navigateMock)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { priceDisplayMode: 'gross', freeShippingThresholdCents: 15000, serverRuntime: 'cloudflare' }
}))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(false), user: ref(null), session: ref(null) }))

const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.loading || props.disabled },
        slots.default?.()
      )
})
const Alert = defineComponent({ props: ['title'], setup: (props) => () => h('p', props.title) })
const rate = {
  serviceCode: 'pickup',
  label: 'Recogida',
  netCents: 0,
  taxRateBasisPoints: 2100,
  estimatedDeliveryFrom: '2026-10-08',
  estimatedDeliveryTo: '2026-10-09',
  profile: 'pickup',
  pricingVersion: 'v1',
  subtotalNetCents: 1000,
  taxCents: 210,
  totalGrossCents: 1210,
  expiresAt: '2099-01-01T00:00:00Z',
  quoteId: 'original-quote',
  shippingQuoteId: 'original-shipping',
  optionIndex: 0,
  optionHash: 'original-option'
}
type Mounted = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Mounted | undefined
let recovery: { orderId: string | null }
let committed: boolean
const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    paymentMethod: string
    cart: ReturnType<typeof useCartStore>
  }
const requests = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path)
const submit = async () => {
  await wrapper!.get('form').trigger('submit')
  await flushPromises()
}
async function render() {
  wrapper = await mountSuspended(CheckoutPage, {
    route: false,
    global: {
      stubs: {
        ClientOnly: Slot,
        UButton: Button,
        UAlert: Alert,
        UFormField: Slot,
        UInput: true,
        UIcon: true,
        NuxtLink: Slot,
        ProductImage: true
      }
    }
  })
  await flushPromises()
  Object.assign(state().form, { name: 'Cliente Original', email: 'synthetic@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente Original',
    phone: '600000000',
    line1: 'Calle Sintética 1',
    postalCode: '46001',
    city: 'Valencia'
  })
  state().acceptTerms = true
  await nextTick()
}
async function checkOrder() {
  const button = wrapper!.findAll('button').find((entry) => entry.text().includes('Comprobar pedido'))
  expect(button, 'manual recovery must remain available in this session').toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
beforeEach(() => {
  committed = false
  recovery = { orderId: null }
  navigateMock.mockReset()
  localStorage.removeItem('neteco-cart-cache')
  localStorage.removeItem('neteco-cart')
  localStorage.removeItem('neteco-cart-add-v1')
  fetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return recovery
    if (path === '/api/cart')
      return {
        id: 'original-cart',
        version: 2,
        status: 'active',
        count: 1,
        subtotal: 1210,
        subtotalNet: 1000,
        tax: 210,
        items: [
          {
            productId: 1,
            variantId: 1,
            slug: 'synthetic',
            name: 'Producto sintético',
            sku: 'SYNTHETIC',
            price: 1210,
            netPrice: 1000,
            qty: 1
          }
        ]
      }
    if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
    if (path === '/api/orders') {
      committed = true
      recovery = { orderId: 'same-committed-order' }
      throw new TypeError('Response lost after commit')
    }
    throw new Error('Unexpected API request: ' + path)
  })
})
afterEach(() => {
  if (wrapper) state().cart.resetLocal()
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('checkout command recovery at the real page/API boundary', () => {
  it('blocks delivery quotes, orders and payment while an ADD result is uncertain', async () => {
    await render()
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/cart/items') throw new TypeError('ADD response lost')
      if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
      if (path === '/api/orders') return { id: 'must-not-create' }
      throw new Error('Unexpected API request: ' + path)
    })
    await expect(state().cart.add({ variantId: 1 }, 1)).rejects.toThrow('No sabemos si se añadió el producto')
    expect(state().cart.pendingMutation).toBe(true)
    fetchMock.mockClear()
    await submit()
    expect(requests('/api/shipping/rates')).toHaveLength(0)
    expect(requests('/api/orders')).toHaveLength(0)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
    expect(wrapper!.text()).toContain('Comprueba la adición en el carrito')
  })
  it('discards a quote resolving after an ADD starts instead of creating an order', async () => {
    await render()
    let resolveQuote!: (value: unknown) => void
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates') return new Promise((resolve) => (resolveQuote = resolve))
      if (path === '/api/cart/items') throw new TypeError('ADD response lost')
      if (path === '/api/orders') return { id: 'must-not-create' }
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    await expect(state().cart.add({ variantId: 1 }, 1)).rejects.toThrow('No sabemos si se añadió el producto')
    resolveQuote({ cartVersion: 2, rates: [rate] })
    await flushPromises()
    expect(requests('/api/orders')).toHaveLength(0)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
    expect(wrapper!.text()).toContain('Comprueba la adición en el carrito')
  })
  it('retains a just-created order but never starts payment after a concurrent uncertain ADD', async () => {
    await render()
    let resolveOrder!: (value: unknown) => void
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
      if (path === '/api/orders') return new Promise((resolve) => (resolveOrder = resolve))
      if (path === '/api/cart/items') throw new TypeError('ADD response lost')
      if (path === '/api/checkout/pay') throw new TypeError('Payment response lost')
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    await expect(state().cart.add({ variantId: 1 }, 1)).rejects.toThrow('No sabemos si se añadió el producto')
    resolveOrder({ id: 'same-created-order' })
    await flushPromises()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
    expect(wrapper!.text()).toContain('Comprueba la adición en el carrito')
  })
  it.each([
    { status: 400, code: 'invalid_input' },
    { status: 422, code: 'method_unavailable' },
    { status: 422, code: 'marketing_unavailable' }
  ])('allows manual correction after a definitive Cloudflare rejection: $status $code', async ({ status, code }) => {
    await render()
    let rejected = false
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
      if (path === '/api/orders') {
        if (!rejected) {
          rejected = true
          throw { status, data: { error: { code } } }
        }
        return { id: 'corrected-order' }
      }
      if (path === '/api/checkout/pay') throw new TypeError('Payment response lost')
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/recover')).toHaveLength(1)
    expect(wrapper!.findAll('button').some((button) => button.text().includes('Comprobar pedido'))).toBe(false)
    const originalKey = requests('/api/orders')[0]![1].headers['Idempotency-Key']
    state().form.name = 'Cliente Corregido'
    state().paymentMethod = 'bizum'
    await nextTick()
    expect(requests('/api/orders')).toHaveLength(1)
    await submit()
    expect(requests('/api/orders')).toHaveLength(2)
    const corrected = requests('/api/orders')[1]![1]
    expect(corrected.headers['Idempotency-Key']).not.toBe(originalKey)
    expect(corrected.body.customer.name).toBe('Cliente Corregido')
    expect(corrected.body.paymentMethod).toBe('bizum')
    expect(requests('/api/checkout/pay')[0]![1].body.orderId).toBe('corrected-order')
  })
  it.each([
    { statusCode: 400, code: 'unknown' },
    { statusCode: 400, code: undefined },
    { statusCode: 401, code: 'unauthorized' },
    { statusCode: 500, code: 'invalid_input' },
    { statusCode: 400, code: 'method_unavailable' }
  ])('retains an ambiguous creation after $statusCode with code $code', async ({ statusCode, code }) => {
    await render()
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
      if (path === '/api/orders') throw { statusCode, data: { error: { code } } }
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    state().form.name = 'Cliente Editado'
    await nextTick()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
    expect(wrapper!.findAll('button').some((button) => button.text().includes('Comprobar pedido'))).toBe(true)
  })
  it('does not apply Cloudflare rejection codes to the legacy checkout contract', async () => {
    await render()
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates')
        return {
          cartVersion: 2,
          rates: [
            { ...rate, quoteId: undefined, shippingQuoteId: undefined, optionHash: undefined, optionIndex: undefined }
          ]
        }
      if (path === '/api/orders') throw { statusCode: 400, data: { error: { code: 'invalid_input' } } }
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    state().form.name = 'Cliente Editado'
    await nextTick()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/orders')[0]![1].body.guestToken).toEqual(expect.any(String))
  })
  it('manually recovers a committed order after response loss, with no automatic payment or second order', async () => {
    await render()
    await submit()
    expect(committed).toBe(true)
    expect(requests('/api/checkout/recover')).toHaveLength(1)
    await checkOrder()
    expect(navigateMock).toHaveBeenCalledWith('/pedido/same-committed-order', { replace: true })
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
  })
  it('does not replace an uncertain command after edits or quote expiry', async () => {
    await render()
    await submit()
    const originalKey = requests('/api/orders')[0]![1].headers['Idempotency-Key']
    Object.assign(state().form, { name: 'Cliente Editado' })
    Object.assign(state().shippingAddress, { line1: 'Otra dirección 99' })
    state().paymentMethod = 'bizum'
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    await nextTick()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    await checkOrder()
    expect(requests('/api/orders')[0]![1].headers['Idempotency-Key']).toBe(originalKey)
    expect(navigateMock).toHaveBeenCalledWith('/pedido/same-committed-order', { replace: true })
  })
  it('gates two submit events before the quote request resolves', async () => {
    await render()
    let resolveQuote!: (value: unknown) => void
    fetchMock.mockImplementation((path: string) => {
      if (path === '/api/shipping/rates')
        return new Promise((resolve) => {
          resolveQuote = resolve
        })
      if (path === '/api/orders') return Promise.reject(new TypeError('Response lost'))
      throw new Error('Unexpected API request: ' + path)
    })
    await wrapper!.get('form').trigger('submit')
    await wrapper!.get('form').trigger('submit')
    expect(requests('/api/shipping/rates')).toHaveLength(1)
    resolveQuote({ cartVersion: 2, rates: [rate] })
    await flushPromises()
    expect(requests('/api/orders')).toHaveLength(1)
  })
  it.each([503, 401])('keeps an uncertain order blocked after manual recovery returns %i', async (statusCode) => {
    await render()
    await submit()
    fetchMock.mockImplementation(async () => {
      throw { statusCode, data: { message: 'private backend detail' } }
    })
    await checkOrder()
    expect(wrapper!.text()).toContain('No hemos podido comprobar')
    expect(wrapper!.text()).not.toContain('private backend detail')
    expect(navigateMock).not.toHaveBeenCalled()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/pay')).toHaveLength(0)
  })
  it('gates repeated manual recovery clicks while the authenticated read is pending', async () => {
    await render()
    await submit()
    let resolveRecovery!: (value: unknown) => void
    fetchMock.mockImplementation((path: string) => {
      if (path === '/api/checkout/recover')
        return new Promise((resolve) => {
          resolveRecovery = resolve
        })
      throw new Error('Unexpected API request: ' + path)
    })
    await checkOrder()
    await checkOrder()
    expect(requests('/api/checkout/recover')).toHaveLength(2)
    resolveRecovery({ orderId: 'same-committed-order' })
    await flushPromises()
    expect(navigateMock).toHaveBeenCalledWith('/pedido/same-committed-order', { replace: true })
    expect(requests('/api/orders')).toHaveLength(1)
  })
  it('does not interpret recovery without an order as permission to replace the uncertain intent', async () => {
    await render()
    await submit()
    recovery = { orderId: null }
    await checkOrder()
    expect(wrapper!.text()).toContain('No se ha confirmado')
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(navigateMock).not.toHaveBeenCalled()
  })
  it('retains the known order and original payment command after payment failure and edits', async () => {
    await render()
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
      if (path === '/api/orders') return { id: 'known-order' }
      if (path === '/api/checkout/pay') throw new TypeError('Payment response lost')
      throw new Error('Unexpected API request: ' + path)
    })
    await submit()
    const firstPayment = requests('/api/checkout/pay')[0]![1]
    state().paymentMethod = 'bizum'
    state().form.name = 'Cliente Editado'
    await nextTick()
    await submit()
    expect(requests('/api/orders')).toHaveLength(1)
    expect(requests('/api/checkout/pay')).toHaveLength(2)
    expect(requests('/api/checkout/pay')[1]![1]).toEqual(firstPayment)
  })
})
