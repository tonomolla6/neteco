import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../app/pages/pedido/[id].vue'
import type { OrderDetailView } from '../../shared/types/orders'
import '#app/nuxt-vitest-app-entry'
import { testNow } from '../support/deterministic'

const { read, request, hosted, refresh } = vi.hoisted(() => ({
  read: vi.fn(),
  request: vi.fn(),
  hosted: vi.fn(),
  refresh: vi.fn()
}))
mockNuxtImport('useFetch', () => read)
mockNuxtImport('$fetch', () => request)
mockNuxtImport('refreshNuxtData', () => refresh)
mockNuxtImport('useRoute', () => () => ({ params: { id: 'a1000000-0000-4000-8000-000000000001' }, query: {} }))
mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(false), user: ref(null) }))
vi.mock('../../app/utils/hosted-payment', () => ({ submitHostedPayment: hosted }))
// Isolate Nuxt's unrelated startup homepage, not the order page/payment flow.
// This component regression does not replace compiled-browser acceptance.
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))

const ID = 'a1000000-0000-4000-8000-000000000001'
const order = (patch: Partial<OrderDetailView> = {}): OrderDetailView => ({
  source: 'cloudflare',
  id: ID,
  status: 'pendiente_pago',
  orderStatus: 'awaiting_payment',
  paymentStatus: 'awaiting_payment',
  inventoryStatus: 'reserved',
  fulfillmentStatus: 'untracked',
  invoiceStatus: 'untracked',
  name: 'Cliente sintético',
  company: null,
  nif: null,
  email: 'synthetic@example.invalid',
  phone: '600000000',
  address: 'Calle sintética 1',
  zip: '46870',
  city: 'Ontinyent',
  province: 'Valencia',
  notes: null,
  shippingMethod: 'recogida',
  paymentMethod: 'pendiente',
  transferInstructions: null,
  subtotal: 12100,
  shippingCost: 0,
  tax: 2100,
  total: 12100,
  createdAt: new Date(testNow()).toISOString(),
  reservationExpiresAt: new Date(testNow() + 30 * 60_000).toISOString(),
  items: [],
  ...patch
})
const redirect = {
  actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  method: 'POST',
  fields: { Ds_Signature: 'synthetic' }
}
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.loading || props.disabled }, slots.default?.())
})
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined
let data: Ref<OrderDetailView>
function state() {
  return proxyRefs(wrapper!.setupState) as Record<string, unknown>
}
async function render(patch: Partial<OrderDetailView> = {}) {
  data = ref(order(patch))
  read.mockImplementation((path: string) => ({ data: path.endsWith('/lines') ? ref(null) : data, error: ref(null) }))
  wrapper = await mountSuspended(Page, {
    route: false,
    global: {
      stubs: {
        UiSurface: Surface,
        UButton: Button,
        UIcon: true,
        NuxtLink: Surface,
        OrderFiscalSection: true,
        OrderTrackingPanel: true,
        OrderRefundPanel: true,
        ReorderDialog: true,
        OrderLineThumb: true
      }
    }
  })
  await flushPromises()
  return wrapper
}
async function choose(method: 'tarjeta' | 'bizum') {
  await wrapper!.get(`input[name="order-payment-method"][value="${method}"]`).setValue(true)
}
async function submit() {
  await wrapper!.get('[data-order-payment-submit]').trigger('click')
  await flushPromises()
}
async function recover() {
  await wrapper!.get('[data-order-payment-refresh]').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow())
  read.mockReset()
  request.mockReset()
  hosted.mockReset()
  refresh.mockReset()
  request.mockImplementation(async (_path: string, options: { method?: string }) =>
    options?.method === 'GET' ? order() : { ok: true, redirect }
  )
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

describe('recovered Cloudflare order payment', () => {
  it.each(['failed', 'cancelled'])(
    'view-only %s payment does not falsely claim a live reservation expired',
    async (paymentStatus) => {
      const page = await render({ accessMode: 'view_only', paymentStatus, status: 'pago_fallido' })
      expect(page.text()).toContain('Pago no confirmado')
      expect(page.text()).toContain('solo consulta')
      expect(page.text()).not.toContain('reserva ya no está vigente')
      expect(page.text()).not.toContain('Puedes reintentarlo')
      expect(page.find('[data-order-payment-submit]').exists()).toBe(false)
      expect(page.find('input[name="order-payment-method"]').exists()).toBe(false)
      await (state().retryPayment as () => Promise<void>)()
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('preserves the original Node payment retry without Cloudflare access-mode semantics', async () => {
    const page = await render({ source: undefined, paymentStatus: 'failed', paymentMethod: 'tarjeta' })
    expect(page.find('[data-order-payment-submit]').exists()).toBe(true)
    await submit()
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/checkout/pay', {
      method: 'POST',
      retry: 0,
      body: { orderId: ID, method: 'tarjeta' }
    })
    expect(hosted).toHaveBeenCalledExactlyOnceWith(redirect)
  })
  it('explains sealed guest view-only access without offering or programmatically initiating payment', async () => {
    const page = await render({ accessMode: 'view_only' } as Partial<OrderDetailView>)
    expect(page.text()).toContain('solo consulta')
    expect(page.find('input[name="order-payment-method"]').exists()).toBe(false)
    expect(page.find('[data-order-payment-submit]').exists()).toBe(false)
    await (state().retryPayment as () => Promise<void>)()
    expect(request).not.toHaveBeenCalled()
    expect(hosted).not.toHaveBeenCalled()
  })

  it('a fresh view-only read discards the previous local payment intention without replay', async () => {
    await render()
    await choose('bizum')
    request.mockRejectedValueOnce(new Error('lost'))
    await submit()
    expect(state().paymentIntent).not.toBeNull()
    request.mockResolvedValueOnce(order({ accessMode: 'view_only' } as Partial<OrderDetailView>))
    await recover()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![1].method).toBe('GET')
    expect(state().paymentIntent).toBeNull()
    expect(state().paymentSelection).toBe('')
    expect(wrapper!.text()).toContain('solo consulta')
    expect(wrapper!.find('[data-order-payment-submit]').exists()).toBe(false)
    expect(wrapper!.find('input[name="order-payment-method"]').exists()).toBe(false)
    await (state().retryPayment as () => Promise<void>)()
    expect(request).toHaveBeenCalledTimes(2)
    expect(hosted).not.toHaveBeenCalled()
  })

  it('suppresses a late hosted redirect after the current DTO becomes view-only', async () => {
    await render({ paymentMethod: 'tarjeta' })
    let done!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const pending = (state().retryPayment as () => Promise<void>)()
    expect(request).toHaveBeenCalledTimes(1)
    data.value = order({ accessMode: 'view_only' } as Partial<OrderDetailView>)
    await nextTick()
    expect(state().paymentIntent).toBeNull()
    done({ ok: true, redirect })
    await pending
    expect(request).toHaveBeenCalledTimes(1)
    expect(hosted).not.toHaveBeenCalled()
    expect(state().paymentRetryError).toBe('')
  })

  it.each(['tarjeta', 'bizum'] as const)('requires explicit %s selection and starts only on click', async (method) => {
    const page = await render()
    expect(request).not.toHaveBeenCalled()
    expect(page.get('[data-order-payment-submit]').attributes('disabled')).toBeDefined()
    await choose(method)
    expect(request).not.toHaveBeenCalled()
    await submit()
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/api/checkout/pay',
      expect.objectContaining({
        method: 'POST',
        retry: 0,
        headers: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) },
        body: { orderId: ID, method }
      })
    )
    expect(hosted).toHaveBeenCalledExactlyOnceWith(redirect)
  })

  it('guards concurrent programmatic submissions, not just a disabled button', async () => {
    await render({ paymentStatus: 'failed', paymentMethod: 'tarjeta' })
    let done!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const retry = state().retryPayment as () => Promise<void>
    const first = retry()
    const second = retry()
    expect(request).toHaveBeenCalledTimes(1)
    done({ ok: true, redirect })
    await Promise.all([first, second])
    expect(hosted).toHaveBeenCalledTimes(1)
  })

  it('retains exact body/key after a lost response; GET never automatically repeats payment', async () => {
    await render()
    await choose('bizum')
    request.mockRejectedValueOnce(new Error('private-lost-response'))
    await submit()
    const original = structuredClone(request.mock.calls[0]!)
    expect(wrapper!.text()).not.toContain('private-lost-response')
    expect(hosted).not.toHaveBeenCalled()
    expect(wrapper!.get('input[value="tarjeta"]').attributes('disabled')).toBeDefined()
    request.mockResolvedValueOnce(
      order({ paymentStatus: 'processing', paymentMethod: 'bizum', status: 'procesando_pago' })
    )
    await recover()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]).toEqual([`/api/orders/${ID}`, { method: 'GET', retry: 0, cache: 'no-store' }])
    await submit()
    expect(request.mock.calls[2]).toEqual(original)
    expect(hosted).toHaveBeenCalledExactlyOnceWith(redirect)
  })

  it.each([401, 403])('requires an authoritative GET after payment %s', async (status) => {
    await render({ paymentStatus: 'failed', paymentMethod: 'tarjeta' })
    request.mockRejectedValueOnce({ statusCode: status })
    await submit()
    await (state().retryPayment as () => Promise<void>)()
    expect(request).toHaveBeenCalledTimes(1)
    request.mockRejectedValueOnce({ statusCode: status })
    await recover()
    expect(hosted).not.toHaveBeenCalled()
    await (state().retryPayment as () => Promise<void>)()
    expect(request).toHaveBeenCalledTimes(2)
    request.mockResolvedValueOnce(order({ paymentMethod: 'tarjeta' }))
    await recover()
    await submit()
    expect(request.mock.calls[3]).toEqual(request.mock.calls[0])
  })

  it.each([
    { inventoryStatus: 'released' },
    { reservationExpiresAt: new Date(0).toISOString() },
    { orderStatus: 'cancelled', status: 'cancelado' },
    { paymentStatus: 'captured', status: 'pagado' },
    { paymentStatus: 'authorized' },
    { paymentStatus: 'processing' }
  ])('does not initiate against an ineligible server order %#', async (patch) => {
    await render(patch)
    expect(wrapper!.find('[data-order-payment-submit]').exists()).toBe(false)
    await (state().retryPayment as () => Promise<void>)()
    expect(request).not.toHaveBeenCalled()
  })

  it('blocks a paid or foreign recovery response instead of replaying', async () => {
    await render()
    await choose('tarjeta')
    request.mockRejectedValueOnce(new Error('lost'))
    await submit()
    request.mockResolvedValueOnce(order({ id: 'a1000000-0000-4000-8000-000000000002' }))
    await recover()
    await (state().retryPayment as () => Promise<void>)()
    expect(request).toHaveBeenCalledTimes(2)
    request.mockResolvedValueOnce(order({ paymentStatus: 'captured', status: 'pagado' }))
    await recover()
    expect(wrapper!.find('[data-order-payment-submit]').exists()).toBe(false)
    expect(hosted).not.toHaveBeenCalled()
  })

  it('rechecks real TTL at click time, even if no reactive field changed', async () => {
    await render({ paymentStatus: 'failed', paymentMethod: 'tarjeta' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(data.value.reservationExpiresAt!) + 1)
    try {
      await (state().retryPayment as () => Promise<void>)()
      expect(request).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it('allows a new explicit card intention after a definitive Bizum-unavailable rejection', async () => {
    await render()
    await choose('bizum')
    request.mockRejectedValueOnce({ statusCode: 422, data: { error: { code: 'method_unavailable' } } })
    await submit()
    const previous = request.mock.calls[0]!
    expect(wrapper!.text()).toContain('Bizum')
    await choose('tarjeta')
    await submit()
    expect(request.mock.calls[1]![1].body).toEqual({ orderId: ID, method: 'tarjeta' })
    expect(request.mock.calls[1]![1].headers['Idempotency-Key']).not.toBe(previous[1].headers['Idempotency-Key'])
    expect(hosted).toHaveBeenCalledTimes(1)
  })

  it.each([null, { ...redirect, actionUrl: 'https://foreign.example.invalid/' }])(
    'does not claim payment or submit a malformed/untrusted redirect %#',
    async (bad) => {
      await render()
      await choose('tarjeta')
      request.mockResolvedValueOnce({ ok: true, redirect: bad })
      await submit()
      expect(hosted).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
      expect(wrapper!.find('[data-order-payment-refresh]').exists()).toBe(true)
      expect(wrapper!.text()).not.toContain('Pago confirmado')
    }
  )

  it('suppresses late redirect if the current order identity changed', async () => {
    await render({ paymentStatus: 'failed', paymentMethod: 'tarjeta' })
    let done!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      })
    )
    const pending = (state().retryPayment as () => Promise<void>)()
    data.value = order({ id: 'a1000000-0000-4000-8000-000000000002' })
    await nextTick()
    done({ ok: true, redirect })
    await pending
    expect(hosted).not.toHaveBeenCalled()
  })
})
