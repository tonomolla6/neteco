import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../app/pages/pedido/[id].vue'
import '#app/nuxt-vitest-app-entry'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
mockNuxtImport('useFetch', () => read)
mockNuxtImport('useRoute', () => () => ({ params: { id: 'a1000000-0000-4000-8000-000000000001' }, query: {} }))
mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(false), user: ref(null), ready: ref(false) }))
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const fixture = () => ({
  source: 'cloudflare',
  id: 'a1000000-0000-4000-8000-000000000001',
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
  subtotal: 1399,
  subtotalBaseGrossCents: 1500,
  discountGrossCents: 101,
  subtotalNetCents: 1156,
  goodsTaxCents: 243,
  shippingNetCents: 0,
  shippingTaxCents: 0,
  shippingCost: 0,
  tax: 243,
  total: 1399,
  createdAt: '2026-08-12T12:00:00Z',
  items: [
    {
      id: 'synthetic-variant',
      name: 'Producto sintético',
      format: '1 L',
      sku: 'SYNTHETIC',
      price: 500,
      qty: 3,
      lineIndex: 0,
      lineBaseGrossCents: 1500,
      discountGrossCents: 101,
      lineNetCents: 1156,
      lineTaxCents: 243,
      lineGrossCents: 1399
    }
  ]
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
async function render(body: Record<string, unknown> = fixture()) {
  read.mockImplementation((path: unknown) => ({
    data: ref(typeof path === 'string' && path.endsWith('/lines') ? null : body),
    error: ref(null)
  }))
  wrapper = await mountSuspended(Page, {
    route: false,
    global: {
      stubs: {
        UiSurface: Surface,
        UButton: Surface,
        UIcon: true,
        NuxtLink: Surface,
        OrderLineThumb: true,
        OrderFiscalSection: true,
        OrderTrackingPanel: true,
        OrderRefundPanel: true,
        ReorderDialog: true,
        CustomerSatisfactionPanel: true,
        OrderTimelinePanel: true
      }
    }
  })
  await flushPromises()
}
beforeEach(() => read.mockReset())
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
describe('customer order coupon breakdown rendered from contractual amounts', () => {
  it('shows the stored odd-cent payable line total rather than unit price times quantity', async () => {
    await render()
    expect(wrapper!.get('[data-order-line-gross="0"]').text()).toContain('13,99')
    expect(wrapper!.get('[data-order-line-discount="0"]').text()).toContain('1,01')
  })
  it('separates base and included discount without subtracting it twice', async () => {
    await render()
    expect(wrapper!.get('[data-order-subtotal-base]').text()).toContain('15,00')
    expect(wrapper!.get('[data-order-discount]').text()).toContain('1,01')
    expect(wrapper!.get('[data-order-discount]').text()).toContain('incluido')
    expect(wrapper!.get('[data-order-total]').text()).toContain('13,99')
  })
  it('does not invent a discount on historical no-coupon orders', async () => {
    const body = fixture()
    body.discountGrossCents = 0
    body.items[0]!.discountGrossCents = 0
    body.items[0]!.lineGrossCents = 1500
    body.subtotal = 1500
    body.total = 1500
    await render(body)
    expect(wrapper!.find('[data-order-discount]').exists()).toBe(false)
    expect(wrapper!.get('[data-order-line-gross="0"]').text()).toContain('15,00')
  })
  it('preserves legacy Node unit-price rendering when contractual additions are absent', async () => {
    const body = fixture()
    await render({
      ...body,
      source: undefined,
      items: [{ id: 'legacy', name: 'Producto legado', format: '1 L', sku: 'LEGACY', price: 500, qty: 3 }],
      discountGrossCents: undefined,
      subtotalBaseGrossCents: undefined
    })
    expect(wrapper!.text()).toContain('15,00')
    expect(wrapper!.find('[data-order-discount]').exists()).toBe(false)
  })
})
