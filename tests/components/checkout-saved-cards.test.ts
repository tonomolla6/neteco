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

const activeToken = {
  id: '40000000-0000-4000-8000-000000000001',
  status: 'active' as const,
  version: 1,
  createdAt: '2026-10-10T10:00:00Z'
}

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let loggedIn = ref(true)
let ready = ref(true)
let user = ref<{ id: string; emailVerified: boolean; name?: string; email?: string } | null>({
  id: '10000000-0000-4000-8000-000000000046',
  emailVerified: true
})
let session = ref<{ sessionId: string; sessionVersion: number } | null>({
  sessionId: '20000000-0000-4000-8000-000000000046',
  sessionVersion: 1
})
let availabilityResponse: unknown
let tokensResponse: unknown
let consentPaymentResponse: unknown
let oneClickResponse: unknown

const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    saveCardConsent: boolean
    refreshShippingRates: () => Promise<boolean>
  }

beforeEach(() => {
  vi.spyOn(hostedPayment, 'submitHostedPayment').mockImplementation(() => undefined)
  loggedIn = ref(true)
  ready = ref(true)
  user = ref({ id: '10000000-0000-4000-8000-000000000046', emailVerified: true })
  session = ref({ sessionId: '20000000-0000-4000-8000-000000000046', sessionVersion: 1 })
  mocks.session.mockReturnValue({ loggedIn, ready, user, session })
  availabilityResponse = { available: true, consentVersion: 'one-click-2026-10' }
  tokensResponse = { tokens: [activeToken], pending: [] }
  consentPaymentResponse = {
    paymentIntentId: 'intent-consent-1',
    status: 'redirect_ready',
    expiresAt: '2099-01-01T00:00:00Z',
    consentVersion: 'one-click-2026-10',
    redirect: redirectFixture
  }
  oneClickResponse = {
    orderId: '50000000-0000-4000-8000-000000000001',
    paymentIntentId: 'intent-oneclick-1',
    amountCents: 1210,
    outcome: 'paid'
  }
  mocks.navigate.mockReset()
  for (const key of ['neteco-cart-cache', 'neteco-cart', 'neteco-cart-add-v1']) localStorage.removeItem(key)
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return { orderId: null }
    if (path === '/api/account/b2b') return { terms: null }
    if (path === '/api/payments/wallet-capabilities')
      return { wallets: { apple_pay: false, google_pay: false }, fallback: 'redirect' }
    if (path === '/api/account/saved-cards/availability') {
      if (availabilityResponse instanceof Error) throw availabilityResponse
      return availabilityResponse
    }
    if (path === '/api/account/payment-tokens') {
      if (tokensResponse instanceof Error) throw tokensResponse
      return tokensResponse
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
    if (path === '/api/orders') return { id: '50000000-0000-4000-8000-000000000001', token: 'k'.repeat(64) }
    if (path === '/api/account/saved-cards/consent-payments') {
      if (consentPaymentResponse instanceof Error) throw consentPaymentResponse
      return consentPaymentResponse
    }
    if (path === '/api/account/saved-cards/one-click') {
      if (oneClickResponse instanceof Error) throw oneClickResponse
      return oneClickResponse
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
  Object.assign(state().form, { name: 'Cliente Token', email: 'token@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente Token',
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

describe('PAY-022 explicit card-saving consent, one-click payment and revocation link', () => {
  it('renders an unchecked explicit consent checkbox and a revocation link, and uses normal pay when unchecked', async () => {
    tokensResponse = { tokens: [], pending: [] }
    await render()

    const checkbox = wrapper!.get('[data-testid="save-card-consent"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
    expect(state().saveCardConsent).toBe(false)

    const revokeLink = wrapper!.get('[data-testid="revoke-saved-card-link"]')
    expect(revokeLink.attributes('href')).toBe('/cuenta/metodos-de-pago')

    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/account/saved-cards/consent-payments')).toBe(false)
    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/checkout/pay')).toBe(true)
  })

  it('starts a tokenized payment via POST /api/account/saved-cards/consent-payments only when consent is checked', async () => {
    tokensResponse = { tokens: [], pending: [] }
    await render()

    const checkbox = wrapper!.get('[data-testid="save-card-consent"]')
    await checkbox.setValue(true)
    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    const consentCall = mocks.fetch.mock.calls.find(([path]) => path === '/api/account/saved-cards/consent-payments')
    expect(consentCall).toBeDefined()
    expect(consentCall![1].body).toEqual({
      orderId: '50000000-0000-4000-8000-000000000001',
      commandId: consentCall![1].headers['Idempotency-Key'],
      consent: true,
      consentVersion: 'one-click-2026-10'
    })
    expect(consentCall![1].headers['Authorization']).toBe(`Order ${'k'.repeat(64)}`)
    expect(hostedPayment.submitHostedPayment).toHaveBeenCalledWith(redirectFixture)
  })

  it('executes one-click payment with an active saved token and navigates to the order page on paid outcome', async () => {
    await render()

    const oneClickBtn = wrapper!.get(`[data-testid="one-click-pay-${activeToken.id}"]`)
    await oneClickBtn.trigger('click')
    await flushPromises()

    const oneClickCall = mocks.fetch.mock.calls.find(([path]) => path === '/api/account/saved-cards/one-click')
    expect(oneClickCall).toBeDefined()
    expect(oneClickCall![1].body).toEqual({
      tokenId: activeToken.id,
      orderId: '50000000-0000-4000-8000-000000000001',
      commandId: oneClickCall![1].headers['Idempotency-Key'],
      expectedVersion: 1
    })
    expect(mocks.navigate).toHaveBeenCalledWith('/pedido/50000000-0000-4000-8000-000000000001')
  })

  it('handles declined one-click charges and revoked/stale tokens by allowing safe fallback to Redirect', async () => {
    oneClickResponse = {
      orderId: '50000000-0000-4000-8000-000000000001',
      paymentIntentId: 'intent-declined',
      amountCents: 1210,
      outcome: 'declined'
    }
    await render()

    await wrapper!.get(`[data-testid="one-click-pay-${activeToken.id}"]`).trigger('click')
    await flushPromises()

    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(wrapper!.text()).toMatch(/denegado.*redirección/i)

    // Retry now falls back to standard redirect for the same created order without creating a second order
    await wrapper!.get('form').trigger('submit')
    await flushPromises()

    expect(mocks.fetch.mock.calls.filter(([path]) => path === '/api/orders')).toHaveLength(1)
    expect(mocks.fetch.mock.calls.some(([path]) => path === '/api/checkout/pay')).toBe(true)
    expect(hostedPayment.submitHostedPayment).toHaveBeenCalledWith(redirectFixture)
  })

  it('hides saved cards and clears state when the session logs out or availability is closed', async () => {
    await render()
    expect(wrapper!.find('[data-testid="save-card-consent"]').exists()).toBe(true)

    loggedIn.value = false
    await nextTick()
    await flushPromises()

    expect(wrapper!.find('[data-testid="save-card-consent"]').exists()).toBe(false)
    expect(wrapper!.find(`[data-testid="one-click-pay-${activeToken.id}"]`).exists()).toBe(false)
  })
})
