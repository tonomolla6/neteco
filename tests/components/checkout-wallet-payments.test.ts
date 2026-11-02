import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Checkout from '../../app/pages/checkout.vue'
import * as hostedPayment from '../../app/utils/hosted-payment'
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

const redirectFixture = {
  actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  method: 'POST' as const,
  fields: {
    Ds_SignatureVersion: 'HMAC_SHA256_V1',
    Ds_MerchantParameters: 'eyJEU19NRVJDSEFOVF9BTU9VTlQiOiIxMjEwIn0=',
    Ds_Signature: 'sig'
  }
}

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let capabilitiesResponse: unknown
let walletIntentResponse: unknown

const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    walletDeviceAvailable: boolean
    refreshShippingRates: () => Promise<boolean>
  }

beforeEach(() => {
  vi.spyOn(hostedPayment, 'submitHostedPayment').mockImplementation(() => undefined)
  capabilitiesResponse = { wallets: { apple_pay: false, google_pay: false }, fallback: 'redirect' }
  walletIntentResponse = {
    paymentIntentId: 'intent-1',
    status: 'redirect_ready',
    redirect: redirectFixture,
    wallet: { requested: 'google_pay', resolved: 'google_pay', fallback: 'redirect' }
  }
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
    if (path === '/api/payments/wallet-capabilities') {
      if (capabilitiesResponse instanceof Error) throw capabilitiesResponse
      return capabilitiesResponse
    }
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
    if (path === '/api/orders') return { id: '30000000-0000-4000-8000-000000000001', token: 't'.repeat(64) }
    if (path === '/api/orders/30000000-0000-4000-8000-000000000001/wallet-payment-intents') {
      if (walletIntentResponse instanceof Error) throw walletIntentResponse
      return walletIntentResponse
    }
    if (path === '/api/checkout/pay') return { ok: true, redirect: redirectFixture }
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
  Object.assign(state().form, { name: 'Cliente Wallet', email: 'wallet@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente Wallet',
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

describe('PAY-019 Apple Pay / Google Pay checkout wiring', () => {
  it('hides wallet buttons by default and when capability discovery fails', async () => {
    await render()
    expect(wrapper!.find('[data-testid="wallet-pay-apple_pay"]').exists()).toBe(false)
    expect(wrapper!.find('[data-testid="wallet-pay-google_pay"]').exists()).toBe(false)

    wrapper!.unmount()
    capabilitiesResponse = new Error('network error')
    await render()
    expect(wrapper!.find('[data-testid="wallet-pay-apple_pay"]').exists()).toBe(false)
    expect(wrapper!.find('[data-testid="wallet-pay-google_pay"]').exists()).toBe(false)
  })

  it('renders only the approved wallet button and submits via POST /api/orders/:id/wallet-payment-intents', async () => {
    capabilitiesResponse = { wallets: { apple_pay: false, google_pay: true }, fallback: 'redirect' }
    await render()

    expect(wrapper!.find('[data-testid="wallet-pay-apple_pay"]').exists()).toBe(false)
    const googleBtn = wrapper!.get('[data-testid="wallet-pay-google_pay"]')
    await googleBtn.trigger('click')
    await flushPromises()

    const walletCall = mocks.fetch.mock.calls.find(
      ([path]) => path === '/api/orders/30000000-0000-4000-8000-000000000001/wallet-payment-intents'
    )
    expect(walletCall).toBeDefined()
    expect(walletCall![1].body).toEqual({ method: 'google_pay', deviceAvailable: true })
    expect(walletCall![1].headers['Idempotency-Key']).toEqual(expect.any(String))
    expect(walletCall![1].headers['Authorization']).toBe(`Order ${'t'.repeat(64)}`)
    expect(hostedPayment.submitHostedPayment).toHaveBeenCalledWith(redirectFixture)
  })

  it('falls back to Redirect with an accessible notice when the server resolves redirect', async () => {
    capabilitiesResponse = { wallets: { apple_pay: true, google_pay: false }, fallback: 'redirect' }
    walletIntentResponse = {
      paymentIntentId: 'intent-fallback',
      status: 'redirect_ready',
      redirect: redirectFixture,
      wallet: { requested: 'apple_pay', resolved: 'redirect', fallback: 'redirect' }
    }
    await render()
    state().walletDeviceAvailable = false
    await nextTick()

    await wrapper!.get('[data-testid="wallet-pay-apple_pay"]').trigger('click')
    await flushPromises()

    const walletCall = mocks.fetch.mock.calls.find(
      ([path]) => path === '/api/orders/30000000-0000-4000-8000-000000000001/wallet-payment-intents'
    )
    expect(walletCall![1].body).toEqual({ method: 'apple_pay', deviceAvailable: false })
    expect(wrapper!.get('[data-testid="wallet-fallback-notice"]').attributes('role')).toBe('status')
    expect(hostedPayment.submitHostedPayment).toHaveBeenCalledWith(redirectFixture)
  })
})
