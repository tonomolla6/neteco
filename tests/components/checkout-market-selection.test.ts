import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Checkout from '../../app/pages/checkout.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  session: vi.fn(),
  navigate: vi.fn(),
  runtime: {
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', priceDisplayMode: 'gross', freeShippingThresholdCents: 15000 }
  }
}))
mockNuxtImport('$fetch', () => mocks.fetch)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('navigateTo', () => mocks.navigate)
mockNuxtImport('useRuntimeConfig', () => () => mocks.runtime)
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
const Alert = defineComponent({
  props: ['title'],
  setup: (props) => () => h('p', { role: 'alert' }, props.title)
})

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
  quoteId: '10000000-0000-4000-8000-000000000001',
  shippingQuoteId: '10000000-0000-4000-8000-000000000002',
  optionIndex: 0,
  optionHash: 'a'.repeat(64)
}

const gbProfile = {
  market: 'GB',
  currency: 'GBP',
  version: 2,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v2',
  paymentMethods: ['card'] as const
}

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let marketResponse: unknown

const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    paymentMethod: string
    refreshShippingRates: () => Promise<boolean>
    checkoutCommand: { body: Record<string, unknown> } | null
  }

beforeEach(() => {
  mocks.runtime.public.serverRuntime = 'cloudflare'
  marketResponse = gbProfile
  mocks.session.mockReturnValue({
    loggedIn: ref(false),
    ready: ref(true),
    user: ref(null),
    session: ref(null)
  })
  mocks.navigate.mockReset()
  for (const key of ['neteco-cart-cache', 'neteco-cart', 'neteco-cart-add-v1']) localStorage.removeItem(key)
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return { orderId: null }
    if (path === '/api/payments/wallet-capabilities')
      return { wallets: { apple_pay: false, google_pay: false }, fallback: 'redirect' }
    if (path === '/api/cart')
      return {
        id: 'cart-1',
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
    if (path === '/api/checkout-markets/GB') {
      if (marketResponse instanceof Error) throw marketResponse
      return marketResponse
    }
    if (path === '/api/orders') return { id: 'market-order-1' }
    if (path === '/api/checkout/pay') return { ok: true, redirect: null }
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
  Object.assign(state().form, { name: 'Cliente GB', email: 'gb@example.invalid', phone: '+44123456789' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente GB',
    phone: '+44123456789',
    line1: 'Example Street 10',
    postalCode: '46001',
    city: 'London',
    region: 'London'
  })
  state().acceptTerms = true
  await nextTick()
  await state().refreshShippingRates()
  await flushPromises()
}

describe('CHK-023 checkout market selector and revalidation', () => {
  it('loads the public market profile when a non-ES country is selected and displays tax, shipping, terms and total', async () => {
    await render()
    const select = wrapper!.get('[data-testid="checkout-market-select"]')
    expect(wrapper!.find('label[for="shipping-country"]').text()).toContain('País')
    await select.setValue('GB')
    await flushPromises()

    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/checkout-markets/GB')).toBe(true)
    const summary = wrapper!.get('[data-testid="checkout-market-summary"]')
    expect(summary.text()).toContain('GB')
    expect(summary.text()).toContain('GBP')
    expect(wrapper!.get('[data-testid="checkout-market-terms"]').text()).toContain('gb-terms-v2')
    // goodsNet 1000 EUR -> 860 GBP minor, tax 20% = 172, shipping 450 + 90 = 540, total = 1572 (15,72 GBP)
    expect(wrapper!.get('[data-testid="checkout-market-tax"]').text()).toContain('1,72')
    expect(wrapper!.get('[data-testid="checkout-market-shipping"]').text()).toContain('5,40')
    expect(wrapper!.get('[data-testid="checkout-market-total"]').text()).toContain('15,72')
  })

  it('sends marketCheckout and the market presentment expectedTotalGrossCents on order creation, and hides Bizum outside ES', async () => {
    await render()
    state().paymentMethod = 'bizum'
    await wrapper!.get('[data-testid="checkout-market-select"]').setValue('GB')
    await flushPromises()

    expect(state().paymentMethod).toBe('tarjeta')
    expect(wrapper!.find('input[value="bizum"]').exists()).toBe(false)

    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    const orderCall = mocks.fetch.mock.calls.find(([path]) => path === '/api/orders')
    expect(orderCall).toBeDefined()
    expect(orderCall![1].body.marketCheckout).toEqual({
      market: 'GB',
      version: 2,
      termsVersion: 'gb-terms-v2'
    })
    expect(orderCall![1].body.expectedTotalGrossCents).toBe(1572)
    expect(orderCall![1].body.shippingAddress.countryCode).toBe('GB')
  })

  it('shows loading and accessible error state when the selected market has no active profile and blocks submission', async () => {
    let resolveMarket!: (value: unknown) => void
    marketResponse = new Promise((r) => {
      resolveMarket = r
    })
    await render()
    await wrapper!.get('[data-testid="checkout-market-select"]').setValue('GB')
    await nextTick()
    expect(wrapper!.get('[data-testid="checkout-market-loading"]').attributes('role')).toBe('status')

    resolveMarket(Promise.reject({ statusCode: 404, data: { error: { code: 'not_found' } } }))
    await flushPromises()

    const alert = wrapper!.get('[data-testid="checkout-market-error"]')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('No hemos podido cargar')

    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/orders')).toBe(false)
  })

  it('revalidates and reloads the market profile when version or terms change before commit', async () => {
    await render()
    await wrapper!.get('[data-testid="checkout-market-select"]').setValue('GB')
    await flushPromises()

    let firstAttempt = true
    const updatedProfile = {
      ...gbProfile,
      version: 3,
      goodsTaxBps: 1900,
      termsVersion: 'gb-terms-v3'
    }
    const baseImpl = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path === '/api/checkout-markets/GB') return updatedProfile
      if (path === '/api/orders' && firstAttempt) {
        firstAttempt = false
        throw {
          statusCode: 409,
          data: { outcome: 'revalidation_required', reason: 'terms_changed', error: { code: 'CHECKOUT_QUOTE_CHANGED' } }
        }
      }
      return baseImpl(path, ...args)
    })

    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    expect(state().checkoutCommand).toBeNull()
    expect(state().acceptTerms).toBe(false)
    expect(wrapper!.get('[data-testid="checkout-market-terms"]').text()).toContain('gb-terms-v3')
    expect(wrapper!.text()).toMatch(/términos.*mercado|condiciones.*mercado/i)

    state().acceptTerms = true
    await nextTick()
    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    const orderCalls = mocks.fetch.mock.calls.filter(([path]) => path === '/api/orders')
    expect(orderCalls).toHaveLength(2)
    expect(orderCalls[1]![1].body.marketCheckout).toEqual({
      market: 'GB',
      version: 3,
      termsVersion: 'gb-terms-v3'
    })
  })
})
