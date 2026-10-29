import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutPage from '../../app/pages/checkout.vue'
import type { useCartStore } from '../../app/stores/cart'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  runtime: {
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { priceDisplayMode: 'gross', freeShippingThresholdCents: 15000, serverRuntime: 'cloudflare' }
  }
}))
mockNuxtImport('$fetch', () => mocks.fetch)
mockNuxtImport('useRuntimeConfig', () => () => mocks.runtime)
mockNuxtImport('navigateTo', () => vi.fn())
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
  quoteId: 'quote',
  shippingQuoteId: 'shipping',
  optionIndex: 0,
  optionHash: 'option'
}
type Mounted = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Mounted | undefined
const state = () =>
  proxyRefs(wrapper!.setupState) as unknown as {
    form: Record<string, string>
    shippingAddress: Record<string, string>
    acceptTerms: boolean
    cart: ReturnType<typeof useCartStore>
    couponDraft: string
    shippingRates: (typeof rate)[]
    refreshShippingRates: () => Promise<boolean>
    submitting: boolean
    pendingOrder: { id: string; cloudflare: boolean } | null
    checkoutCommand: {
      body: Record<string, unknown>
      cloudflare: boolean
      paymentMethod: string
      paymentKey: string
    } | null
  }
const quotes = () => mocks.fetch.mock.calls.filter(([path]) => path === '/api/shipping/rates')
const input = () => wrapper!.get('[data-testid="checkout-coupon-code"]')
const apply = async () => {
  await wrapper!.get('[data-testid="checkout-coupon-apply"]').trigger('click')
  await flushPromises()
}
async function render() {
  wrapper = await mountSuspended(CheckoutPage, {
    route: false,
    global: {
      stubs: {
        ClientOnly: Slot,
        UButton: Button,
        UFormField: Slot,
        UInput: true,
        UIcon: true,
        UAlert: true,
        NuxtLink: Slot,
        ProductImage: true
      }
    }
  })
  await flushPromises()
  Object.assign(state().form, { name: 'Cliente Sintético', email: 'synthetic@example.invalid', phone: '600000000' })
  Object.assign(state().shippingAddress, {
    recipientName: 'Cliente Sintético',
    phone: '600000000',
    line1: 'Calle Sintética 1',
    postalCode: '46001',
    city: 'Valencia'
  })
  state().acceptTerms = true
  await nextTick()
  await state().refreshShippingRates()
  await flushPromises()
  mocks.fetch.mockClear()
}
beforeEach(() => {
  mocks.runtime.public.serverRuntime = 'cloudflare'
  mocks.runtime.public.priceDisplayMode = 'gross'
  for (const key of ['neteco-cart-cache', 'neteco-cart', 'neteco-cart-add-v1']) localStorage.removeItem(key)
  mocks.fetch.mockReset().mockImplementation(async (path: string, options?: { body?: Record<string, unknown> }) => {
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
            name: 'Producto sintético',
            sku: 'SYNTHETIC',
            price: 1210,
            netPrice: 1000,
            qty: 1
          }
        ]
      }
    if (path === '/api/shipping/rates')
      return options?.body?.couponCode
        ? {
            cartVersion: 2,
            rates: [{ ...rate, subtotalNetCents: 900, taxCents: 189, totalGrossCents: 1089 }],
            promotion: { code: options.body.couponCode, applied: true, reason: null, discountGrossCents: 121 }
          }
        : { cartVersion: 2, rates: [rate] }
    if (path === '/api/orders') throw new TypeError('synthetic_lost_order_response')
    throw new Error('unexpected_fixture_request')
  })
})
afterEach(() => {
  if (wrapper) state().cart.resetLocal()
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('real Cloudflare checkout coupon interaction', () => {
  it('releases only the rejected pre-write intent for a non-positive total and asks to adjust the coupon', async () => {
    await render()
    await input().setValue('SAVE')
    await apply()
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === '/api/shipping/rates')
        return {
          cartVersion: 2,
          rates: [{ ...rate, subtotalNetCents: 900, taxCents: 189, totalGrossCents: 1089 }],
          promotion: { code: 'SAVE', applied: true, reason: null, discountGrossCents: 121 }
        }
      if (path === '/api/orders') throw { statusCode: 422, data: { error: { code: 'payment_total_non_positive' } } }
      throw new Error('unexpected_refresh_after_definitive_rejection')
    })
    mocks.fetch.mockClear()
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(state().checkoutCommand).toBeNull()
    expect(state().pendingOrder).toBeNull()
    expect(mocks.fetch.mock.calls.filter(([path]) => path === '/api/orders')).toHaveLength(1)
    expect(quotes()).toHaveLength(1) // The normal pre-submit quote, never a catch/refresh loop.
    expect(wrapper!.get('#checkout-alert').html()).toContain('Quita o ajusta el cupón')
    expect(input().attributes('disabled')).toBeUndefined()
  })
  it('shows an accessible explicit control only for Cloudflare', async () => {
    await render()
    expect(input().attributes('id')).toBeTruthy()
    expect(wrapper!.find(`label[for="${input().attributes('id')}"]`).text()).toContain('Código de descuento')
    expect(wrapper!.get('[data-testid="checkout-coupon-apply"]').attributes('type')).toBe('button')
  })
  it('preserves the Node page and never sends a coupon parameter there', async () => {
    mocks.runtime.public.serverRuntime = 'node'
    await render()
    expect(wrapper!.find('[data-testid="checkout-coupon-code"]').exists()).toBe(false)
    await state().refreshShippingRates()
    expect(quotes()[0]?.[1].body).not.toHaveProperty('couponCode')
  })
  it('applies a normalized code through the real shipping quote and uses server totals only', async () => {
    await render()
    await input().setValue(' save ')
    expect(state().shippingRates).toHaveLength(0)
    await apply()
    expect(quotes()).toHaveLength(1)
    expect(quotes()[0]?.[1]).toMatchObject({ method: 'POST', body: { couponCode: 'SAVE' } })
    expect(quotes()[0]?.[1].headers['Idempotency-Key']).toBeTruthy()
    expect(wrapper!.get('[data-testid="checkout-coupon-feedback"]').text()).toContain('aplicado')
    expect(wrapper!.get('[data-testid="checkout-coupon-discount"]').text()).toContain('IVA incluido')
    expect(state().shippingRates[0]?.totalGrossCents).toBe(1089)
    expect(wrapper!.get('[data-testid="checkout-total"]').text()).toContain('10,89')
  })
  it('does not subtract the discount twice from already discounted net totals', async () => {
    mocks.runtime.public.priceDisplayMode = 'net-and-gross'
    await render()
    await input().setValue('SAVE')
    await apply()
    expect(wrapper!.get('[data-testid="checkout-subtotal"]').text()).toContain('9,00')
    expect(wrapper!.get('[data-testid="checkout-total"]').text()).toContain('10,89')
  })
  it('removes an applied code with a fresh quote and different key, never reusing stale totals', async () => {
    await render()
    await input().setValue('SAVE')
    await apply()
    const original = quotes()[0]?.[1].headers['Idempotency-Key']
    await wrapper!.get('[data-testid="checkout-coupon-remove"]').trigger('click')
    await flushPromises()
    expect(quotes()).toHaveLength(2)
    expect(quotes()[1]?.[1].body).not.toHaveProperty('couponCode')
    expect(quotes()[1]?.[1].headers['Idempotency-Key']).not.toBe(original)
    expect(wrapper!.find('[data-testid="checkout-coupon-discount"]').exists()).toBe(false)
    expect(state().shippingRates[0]?.totalGrossCents).toBe(1210)
  })
  it('renders bounded eligibility feedback, never private rule details', async () => {
    await render()
    mocks.fetch.mockImplementation(async () => ({
      cartVersion: 2,
      rates: [rate],
      promotion: { code: 'SAVE', applied: false, reason: 'usage_limit', discountGrossCents: 0 }
    }))
    await input().setValue('SAVE')
    await apply()
    expect(wrapper!.get('[data-testid="checkout-coupon-feedback"]').text()).toContain('no se puede aplicar')
    expect(wrapper!.text()).not.toContain('usage_limit')
    expect(wrapper!.find('[data-testid="checkout-coupon-discount"]').exists()).toBe(false)
  })
  it('rejects a quote carrying another code rather than accepting its discount', async () => {
    await render()
    mocks.fetch.mockImplementation(async () => ({
      cartVersion: 2,
      rates: [rate],
      promotion: { code: 'OTHER', applied: true, reason: null, discountGrossCents: 121 }
    }))
    await input().setValue('SAVE')
    await apply()
    expect(state().shippingRates).toHaveLength(0)
    expect(wrapper!.get('[data-testid="checkout-coupon-feedback"]').text()).not.toContain('Cupón aplicado')
  })
  it('does not invent success if the coupon response omits its eligibility proof', async () => {
    await render()
    mocks.fetch.mockImplementation(async () => ({ cartVersion: 2, rates: [rate] }))
    await input().setValue('SAVE')
    await apply()
    expect(state().shippingRates).toHaveLength(0)
  })
  it('retries an unresolved quote with the exact same key and body', async () => {
    await render()
    mocks.fetch.mockRejectedValue(new TypeError('synthetic_lost_quote_response'))
    await input().setValue('SAVE')
    await apply()
    await apply()
    expect(quotes()).toHaveLength(2)
    expect(quotes()[1]?.[1]).toEqual(quotes()[0]?.[1])
  })
  it.each(['pendingOrder', 'checkoutCommand', 'submitting', 'cartMutation'] as const)(
    'blocks coupon edits/actions while %s is active',
    async (mode) => {
      await render()
      if (mode === 'pendingOrder') state().pendingOrder = { id: 'existing-order', cloudflare: true }
      if (mode === 'checkoutCommand')
        state().checkoutCommand = { body: {}, cloudflare: true, paymentMethod: 'tarjeta', paymentKey: 'original' }
      if (mode === 'submitting') state().submitting = true
      if (mode === 'cartMutation') {
        mocks.fetch.mockRejectedValue(new TypeError('synthetic_lost_add_response'))
        await expect(state().cart.add({ variantId: 1 }, 1)).rejects.toThrow()
        mocks.fetch.mockClear()
      }
      await nextTick()
      expect(input().attributes('disabled')).toBeDefined()
      expect(wrapper!.get('[data-testid="checkout-coupon-apply"]').attributes('disabled')).toBeDefined()
      await apply()
      expect(quotes()).toHaveLength(0)
    }
  )
  it('rejects Unicode aliases locally without issuing a new server command', async () => {
    await render()
    await input().setValue('SÁVE')
    await apply()
    expect(quotes()).toHaveLength(0)
    expect(wrapper!.get('[data-testid="checkout-coupon-feedback"]').text()).toContain('Revisa')
  })
  it('drops an old quote after the draft changes and keeps the total unconfirmed', async () => {
    await render()
    let resolve!: (value: unknown) => void
    mocks.fetch.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value
        })
    )
    await input().setValue('SAVE')
    await wrapper!.get('[data-testid="checkout-coupon-apply"]').trigger('click')
    await flushPromises()
    state().couponDraft = 'OTHER'
    await nextTick()
    resolve({
      cartVersion: 2,
      rates: [rate],
      promotion: { code: 'SAVE', applied: true, reason: null, discountGrossCents: 121 }
    })
    await flushPromises()
    expect(state().shippingRates).toHaveLength(0)
    expect(wrapper!.find('[data-testid="checkout-coupon-discount"]').exists()).toBe(false)
  })
})
