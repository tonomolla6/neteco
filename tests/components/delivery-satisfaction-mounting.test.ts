import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import OrderPage from '../../app/pages/pedido/[id].vue'
import type { OrderDetailView } from '../../shared/types/orders'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), session: vi.fn() }))
mockNuxtImport('useFetch', () => mocks.read)
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRoute', () => () => ({ params: { id: 'a1000000-0000-4000-8000-000000000001' }, query: {} }))
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const ID = 'a1000000-0000-4000-8000-000000000001'
function fixture(patch: Partial<OrderDetailView> = {}): OrderDetailView {
  return {
    source: 'cloudflare',
    id: ID,
    status: 'pagado',
    orderStatus: 'paid',
    paymentStatus: 'paid',
    inventoryStatus: 'allocated',
    fulfillmentStatus: 'delivered',
    invoiceStatus: 'untracked',
    name: 'Cliente sintético',
    company: null,
    nif: null,
    email: 'synthetic@example.invalid',
    phone: '600000000',
    address: 'Dirección sintética',
    zip: '46870',
    city: 'Ontinyent',
    province: 'Valencia',
    notes: null,
    shippingMethod: 'recogida',
    paymentMethod: 'tarjeta',
    transferInstructions: null,
    subtotal: 12100,
    shippingCost: 0,
    tax: 2100,
    total: 12100,
    createdAt: '2026-10-01T10:00:00Z',
    items: [],
    ...patch
  }
}
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('button', attrs, slots.default?.())
})
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: 'a2000000-0000-4000-8000-000000000001', emailVerified: true }),
    session: ref({ sessionId: 'a3000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  }
}
let actor: ReturnType<typeof identity>
const wrappers: Array<{ unmount(): void }> = []
beforeEach(() => {
  actor = identity()
  mocks.session.mockReturnValue(actor)
  mocks.read.mockReset()
  mocks.request.mockReset()
  mocks.request.mockRejectedValue(new Error('No satisfaction state fixture yet'))
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})
async function render(patch: Partial<OrderDetailView> = {}) {
  mocks.read.mockImplementation((path: string) => ({
    data: ref(
      path.endsWith('/lines')
        ? {
            orderId: ID,
            orderedAt: '2026-10-01T10:00:00Z',
            shippingMethod: 'recogida',
            paymentMethod: 'tarjeta',
            fulfillmentStatus: patch.fulfillmentStatus ?? 'delivered',
            destination: null,
            totals: { subtotalNet: 10000, shippingNet: 0, tax: 2100, total: 12100 },
            shipment: null,
            lines: []
          }
        : fixture(patch)
    ),
    error: ref(null)
  }))
  const wrapper = await mountSuspended(OrderPage, {
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
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('optional delivery satisfaction in the existing order view', () => {
  it('offers an optional assessment on the confirmed delivered owner journey without posting', async () => {
    const wrapper = await render()
    expect(wrapper.find('[aria-label="Valoración opcional de entrega"]').exists()).toBe(true)
    expect(mocks.request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
  it.each(['node', 'guest', 'not-delivered', 'unverified'] as const)(
    'does not offer native submission for %s',
    async (boundary) => {
      if (boundary === 'unverified') actor.user.value.emailVerified = false
      if (boundary === 'guest') actor.loggedIn.value = false
      const wrapper = await render(
        boundary === 'node'
          ? { source: undefined }
          : boundary === 'guest'
            ? { accessMode: 'view_only' }
            : boundary === 'not-delivered'
              ? { fulfillmentStatus: 'in_transit' }
              : {}
      )
      expect(wrapper.find('[aria-label="Valoración opcional de entrega"]').exists()).toBe(false)
    }
  )
})
