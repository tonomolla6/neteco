import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Checkout from '../../app/pages/checkout.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), session: vi.fn(), navigate: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.fetch)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('navigateTo', () => mocks.navigate)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare', priceDisplayMode: 'gross', freeShippingThresholdCents: 15000 }
}))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
})
const Alert = defineComponent({ props: ['title'], setup: (props) => () => h('p', props.title) })
const rate = {
  serviceCode: 'pickup',
  label: 'Recogida',
  netCents: 0,
  taxRateBasisPoints: 2100,
  profile: 'pickup',
  pricingVersion: 'v1',
  subtotalNetCents: 1000,
  taxCents: 210,
  totalGrossCents: 1210,
  estimatedDeliveryFrom: '2026-10-09',
  estimatedDeliveryTo: '2026-10-10',
  expiresAt: '2099-01-01T00:00:00Z',
  quoteId: 'quote',
  shippingQuoteId: 'shipping',
  optionIndex: 0,
  optionHash: 'option'
}
const terms = {
  companyId: '30000000-0000-4000-8000-000000000099',
  companyStatus: 'approved',
  paymentDays: 30,
  creditLimitCents: 2000,
  blocked: false,
  version: 1,
  priceListId: 'list',
  priceListName: 'Profesional',
  exposureCents: 0,
  availableCents: 2000
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let loggedIn = ref(true),
  ready = ref(true),
  user = ref({ id: '10000000-0000-4000-8000-000000000046', emailVerified: true }),
  session = ref({ sessionId: '20000000-0000-4000-8000-000000000046', sessionVersion: 1 })
let response: unknown
const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    paymentMethod: string
    refreshShippingRates: () => Promise<boolean>
    checkoutCommand: unknown
  }
beforeEach(() => {
  loggedIn = ref(true)
  ready = ref(true)
  user = ref({ id: '10000000-0000-4000-8000-000000000046', emailVerified: true })
  session = ref({ sessionId: '20000000-0000-4000-8000-000000000046', sessionVersion: 1 })
  mocks.session.mockReturnValue({ loggedIn, ready, user, session })
  response = { terms }
  mocks.navigate.mockReset()
  for (const key of ['neteco-cart-cache', 'neteco-cart', 'neteco-cart-add-v1']) localStorage.removeItem(key)
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/account/b2b') return response
    if (path === '/api/checkout/recover') return { orderId: null }
    if (path === '/api/cart')
      return {
        id: 'cart',
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
            name: 'Producto',
            sku: 'SYNTHETIC',
            price: 1210,
            netPrice: 1000,
            qty: 1
          }
        ]
      }
    if (path === '/api/shipping/rates') return { cartVersion: 2, rates: [rate] }
    if (path === '/api/orders') return { id: 'credit-order' }
    throw new Error('unexpected API ' + path)
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})
async function render() {
  wrapper = await mountSuspended(Checkout, {
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
  Object.assign(state().form, { name: 'Cliente Ejemplo', email: 'buyer@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente Ejemplo',
    phone: '600000000',
    line1: 'Calle Mayor 1',
    postalCode: '46001',
    city: 'Valencia'
  })
  state().acceptTerms = true
  await nextTick()
  await state().refreshShippingRates()
  await flushPromises()
}
const transfer = () => wrapper!.find('input[value="transferencia"]')
describe('credit in Cloudflare checkout', () => {
  it('lets an approved buyer with terms select transfer and completes without a card payment', async () => {
    await render()
    expect(transfer().exists()).toBe(true)
    await transfer().setValue(true)
    await nextTick()
    // TRLGDCU art. 98.2: the final button must state the payment obligation.
    expect(wrapper!.text()).toContain('Confirmar pedido con obligación de pago')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    const order = mocks.fetch.mock.calls.find(([path]) => path === '/api/orders')
    expect(order?.[1].body.paymentMethod).toBe('transferencia')
    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/checkout/pay')).toBe(false)
    expect(mocks.navigate).toHaveBeenCalledWith('/pedido/credit-order')
  })
  it.each([
    { companyStatus: 'pending' },
    { companyStatus: 'suspended' },
    { blocked: true },
    { paymentDays: 0 },
    { availableCents: 0 }
  ])('hides credit for ineligible conditions %o', async (patch) => {
    response = { terms: { ...terms, ...patch } }
    await render()
    expect(transfer().exists()).toBe(false)
  })
  it('does not request commercial details for a guest', async () => {
    loggedIn.value = false
    await render()
    expect(transfer().exists()).toBe(false)
    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/account/b2b')).toBe(false)
  })
  it('clears the option when the session changes and ignores the old response', async () => {
    let resolve!: (v: unknown) => void
    response = new Promise((r) => {
      resolve = r
    })
    await render()
    loggedIn.value = false
    await nextTick()
    resolve({ terms })
    await flushPromises()
    expect(transfer().exists()).toBe(false)
  })
  it('allows correction after the server rejects the credit limit', async () => {
    await render()
    await transfer().setValue(true)
    const original = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path === '/api/orders') throw { statusCode: 409, data: { error: { code: 'credit_limit_exceeded' } } }
      return original(path, ...args)
    })
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(state().checkoutCommand).toBeNull()
    expect(wrapper!.text()).toContain('límite de crédito')
  })
})
