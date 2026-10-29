import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Checkout from '../../app/pages/checkout.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', priceDisplayMode: 'gross', freeShippingThresholdCents: 15000 }
  }))
}))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('navigateTo', () => mocks.navigate)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
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
const Alert = defineComponent({ props: ['title'], setup: (props) => () => h('p', { role: 'alert' }, props.title) })
const baseRate = {
  serviceCode: 'pickup',
  label: 'Recogida',
  netCents: 0,
  taxRateBasisPoints: 2100,
  profile: 'pickup',
  pricingVersion: 'synthetic-price',
  subtotalNetCents: 1000,
  taxCents: 210,
  totalGrossCents: 1210,
  estimatedDeliveryFrom: '2026-10-09',
  estimatedDeliveryTo: '2026-10-10',
  expiresAt: '2099-01-01T00:00:00Z'
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let cloudflare: boolean, lost: boolean, recovered: boolean
const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    purchaseOrderReference: string
    checkoutCommand: { body: Record<string, unknown>; headers?: Record<string, string> } | null
  }
beforeEach(() => {
  cloudflare = true
  lost = false
  recovered = false
  mocks.navigate.mockReset()
  for (const key of ['neteco-cart-cache', 'neteco-cart', 'neteco-cart-add-v1']) localStorage.removeItem(key)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', priceDisplayMode: 'gross', freeShippingThresholdCents: 15000 }
  })
  mocks.request.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/checkout/recover') return { orderId: recovered ? 'synthetic-original-order' : null }
    if (path === '/api/cart')
      return {
        id: 'synthetic-cart',
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
            name: 'Synthetic product',
            sku: 'SYNTHETIC',
            price: 1210,
            netPrice: 1000,
            qty: 1
          }
        ]
      }
    if (path === '/api/shipping/rates')
      return {
        cartVersion: 2,
        rates: [
          {
            ...baseRate,
            ...(cloudflare
              ? {
                  quoteId: 'synthetic-quote',
                  shippingQuoteId: 'synthetic-shipping',
                  optionIndex: 0,
                  optionHash: 'synthetic-option'
                }
              : {})
          }
        ]
      }
    if (path === '/api/orders') {
      if (lost) throw new TypeError('Synthetic lost response')
      return { id: 'synthetic-original-order' }
    }
    if (path === '/api/checkout/pay') return { ok: true, redirect: null }
    throw new Error('unexpected_api')
  })
})
afterEach(() => wrapper?.unmount())
async function render(node = false) {
  if (node) {
    cloudflare = false
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node', priceDisplayMode: 'gross', freeShippingThresholdCents: 15000 }
    })
  }
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
  Object.assign(state().form, { name: 'Synthetic buyer', email: 'synthetic@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Synthetic buyer',
    phone: '600000000',
    line1: 'Synthetic street 1',
    postalCode: '46870',
    city: 'Ontinyent'
  })
  state().acceptTerms = true
  await nextTick()
}
async function submit() {
  await wrapper!.get('form').trigger('submit')
  await flushPromises()
}
const orderPosts = () => mocks.request.mock.calls.filter(([path]) => path === '/api/orders')
it('offers a labelled optional PO field only in Cloudflare, independent of tax ID and delivery notes', async () => {
  await render()
  const field = wrapper!.get('input#purchase-order-reference')
  expect(wrapper!.get('label[for="purchase-order-reference"]').text()).toBe('Referencia interna / PO (opcional)')
  expect(field.attributes('maxlength')).toBe('120')
  expect(field.attributes('aria-describedby')).toBe('purchase-order-reference-help')
  expect(wrapper!.get('#purchase-order-reference-help').text()).toMatch(/NIF.*notas/i)
  expect(orderPosts()).toHaveLength(0)
})
it('sends normalized PO only as a top-level Cloudflare field and freezes it in the checkout command', async () => {
  await render()
  await wrapper!.get('#purchase-order-reference').setValue('  PO-Cafe\u0301-25  ')
  await submit()
  expect(orderPosts()).toHaveLength(1)
  const body = orderPosts()[0]![1].body
  expect(body.purchaseOrderReference).toBe('PO-Café-25')
  expect(body.customer).not.toHaveProperty('purchaseOrderReference')
  expect(body.shippingAddress).not.toHaveProperty('purchaseOrderReference')
  expect(body.billingAddress).not.toHaveProperty('purchaseOrderReference')
})
it('omits an empty optional reference instead of submitting an empty value', async () => {
  await render()
  await wrapper!.get('#purchase-order-reference').setValue('   ')
  await submit()
  expect(orderPosts()).toHaveLength(1)
  expect(orderPosts()[0]![1].body).not.toHaveProperty('purchaseOrderReference')
})
it.each([
  'x'.repeat(121),
  'PO\nPRIVATE',
  '\nPO',
  'PO\tPRIVATE',
  'PO\u0000PRIVATE',
  'PO\u0085PRIVATE',
  'PO\u2028PRIVATE'
])('rejects invalid programmatic input before any order POST', async (invalid) => {
  await render()
  state().purchaseOrderReference = invalid
  await nextTick()
  await submit()
  expect(orderPosts()).toHaveLength(0)
  expect(wrapper!.text()).toMatch(/referencia.*120|referencia.*línea/i)
})
it('keeps the original PO after a lost response and only recovers by GET without another POST', async () => {
  lost = true
  await render()
  await wrapper!.get('#purchase-order-reference').setValue('PO-ORIGINAL')
  await submit()
  const frozen = JSON.stringify(state().checkoutCommand)
  await wrapper!.get('#purchase-order-reference').setValue('PO-EDITED')
  await submit()
  expect(orderPosts()).toHaveLength(1)
  expect(JSON.stringify(state().checkoutCommand)).toBe(frozen)
  recovered = true
  const check = wrapper!.findAll('button').find((button) => button.text() === 'Comprobar pedido')!
  await check.trigger('click')
  await flushPromises()
  expect(orderPosts()).toHaveLength(1)
  expect(mocks.navigate).toHaveBeenCalledWith('/pedido/synthetic-original-order', { replace: true })
})
it('preserves the legacy Node checkout without showing or sending the new property', async () => {
  await render(true)
  expect(wrapper!.find('#purchase-order-reference').exists()).toBe(false)
  state().purchaseOrderReference = 'PO-MUST-NOT-LEAK'
  await submit()
  expect(orderPosts()).toHaveLength(1)
  expect(orderPosts()[0]![1].body).not.toHaveProperty('purchaseOrderReference')
  expect(orderPosts()[0]![1].body.customer).not.toHaveProperty('purchaseOrderReference')
})
