import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomerPage from '../../app/pages/pedido/[id].vue'
import AdminPage from '../../app/pages/admin/pedidos/[id].vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('useFetch', () => mocks.read)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
mockNuxtImport('useRoute', () => () => ({ params: { id: '10000000-0000-4000-8000-000000000010' }, query: {} }))
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const id = '10000000-0000-4000-8000-000000000010',
  identity = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000001'
const surface = defineComponent({ setup: (_, ctx) => () => h('div', ctx.slots.default?.()) })
const panel = defineComponent({
  name: 'BeplyOrderPanel',
  props: ['orderId', 'audience', 'scopeKey', 'enabled', 'pending'],
  setup: (props) => () => h('section', { 'data-beply-page': props.audience }, 'Synthetic ERP order section')
})
const order = {
  source: 'cloudflare',
  id,
  status: 'pendiente_pago',
  orderStatus: 'awaiting_payment',
  paymentStatus: 'awaiting_payment',
  inventoryStatus: 'reserved',
  fulfillmentStatus: 'untracked',
  invoiceStatus: 'untracked',
  name: 'Synthetic Buyer',
  company: null,
  nif: null,
  email: 'buyer@example.invalid',
  phone: '600000000',
  address: 'Synthetic street 1',
  zip: '46870',
  city: 'Ontinyent',
  province: 'Valencia',
  notes: null,
  shippingMethod: 'recogida',
  paymentMethod: 'pendiente',
  transferInstructions: null,
  subtotal: 1210,
  shippingCost: 0,
  tax: 210,
  total: 1210,
  createdAt: '2026-11-12T10:00:00Z',
  reservationExpiresAt: '2026-11-12T11:00:00Z',
  items: []
}
const adminOrder = {
  ...order,
  number: id,
  totals: { subtotalNet: 1000, discountNet: 0, shippingNet: 0, tax: 210, total: 1210 },
  createdAt: order.createdAt,
  updatedAt: order.createdAt
}
const detail = {
  order: adminOrder,
  capabilities: {
    orderStatusUpdate: false,
    shipments: false,
    tracking: false,
    invoices: false,
    customerPreview: false
  },
  customer: {
    name: 'Synthetic Buyer',
    company: null,
    email: 'buyer@example.invalid',
    phone: '600000000',
    taxId: null,
    isGuest: false,
    companyStatus: null
  },
  shippingAddress: null,
  billingAddress: null,
  lines: [],
  payments: [],
  shipments: [],
  returns: [],
  invoices: [],
  notes: [],
  timeline: [],
  history: []
}
let auth: ReturnType<typeof session>
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: identity, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: sid, sessionVersion: 1 })
  }
}
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  auth = session()
  mocks.session.mockReturnValue(auth)
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: ref({
      state: 'ready',
      identityId: identity,
      sessionId: sid,
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
  })
  mocks.read.mockImplementation((raw: string | (() => string)) => {
    const path = typeof raw === 'function' ? raw() : raw
    return {
      data: ref(path.includes('/api/admin/') ? detail : order),
      error: ref(null),
      status: ref('success'),
      refresh: vi.fn()
    }
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.clearAllMocks()
})
async function render(page: typeof CustomerPage | typeof AdminPage) {
  const wrapper = await mountSuspended(page, {
    route: false,
    global: {
      stubs: {
        BeplyOrderPanel: panel,
        UiSurface: surface,
        UiPageHeader: surface,
        UButton: surface,
        UBadge: surface,
        UIcon: true,
        USelect: true,
        UInput: true,
        UTextarea: true,
        UModal: surface,
        NuxtLink: surface,
        OrderTrackingPanel: true,
        OrderFiscalSection: true,
        OrderRefundPanel: true,
        AdminRefundActions: true,
        OrderFulfillmentSection: true,
        OrderTimelinePanel: true,
        OrderCancellationPanel: true,
        OrderAnnotationsPanel: true,
        CustomerSatisfactionPanel: true,
        ReorderDialog: true,
        OrderLineThumb: true
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('Beply order panel mounted in actual customer/admin pages', () => {
  it('mounts the account panel only while the current session owns the page context', async () => {
    const wrapper = await render(CustomerPage)
    expect(wrapper.find('[data-beply-page="customer"]').exists()).toBe(true)
    auth.loggedIn.value = false
    await flushPromises()
    expect(wrapper.find('[data-beply-page="customer"]').exists()).toBe(false)
  })
  it('mounts the admin panel under current D1 capability context and removes it after a session change', async () => {
    const wrapper = await render(AdminPage)
    expect(wrapper.find('[data-beply-page="admin"]').exists()).toBe(true)
    auth.session.value.sessionVersion = 2
    await flushPromises()
    expect(wrapper.find('[data-beply-page="admin"]').exists()).toBe(false)
  })
})
