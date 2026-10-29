import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CustomerPage from '../../app/pages/pedido/[id].vue'
import AdminPage from '../../app/pages/admin/pedidos/[id].vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  session: vi.fn(),
  route: vi.fn(),
  navigation: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRoute', () => mocks.route)
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
mockNuxtImport(
  'useRequestFetch',
  () => () =>
    vi.fn(() => {
      throw new Error('unexpected_child_request')
    })
)
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const ORDER = 'a1000000-0000-4000-8000-000000000074',
  ACTOR = 'a2000000-0000-4000-8000-000000000074',
  SESSION = 'a3000000-0000-4000-8000-000000000074'
const TIME = '2026-10-09T12:00:00Z'
const customer = (purchaseOrderReference?: string | null) => ({
  source: 'cloudflare',
  id: ORDER,
  status: 'pagado',
  orderStatus: 'paid',
  paymentStatus: 'captured',
  inventoryStatus: 'allocated',
  fulfillmentStatus: 'packed',
  invoiceStatus: 'untracked',
  name: 'Synthetic buyer',
  company: null,
  nif: null,
  email: 'synthetic@example.invalid',
  phone: '',
  address: '',
  zip: '',
  city: '',
  province: '',
  notes: null,
  shippingMethod: 'recogida',
  paymentMethod: 'tarjeta',
  transferInstructions: null,
  subtotal: 1000,
  shippingCost: 0,
  tax: 210,
  total: 1210,
  createdAt: TIME,
  items: [],
  ...(purchaseOrderReference === undefined ? {} : { purchaseOrderReference })
})
const admin = (purchaseOrderReference?: string | null) => ({
  order: {
    id: ORDER,
    status: 'pagado',
    orderStatus: 'confirmed',
    paymentStatus: 'captured',
    fulfillmentStatus: 'packed',
    inventoryStatus: 'allocated',
    invoiceStatus: 'pending',
    shippingMethod: 'pickup',
    paymentMethod: 'tarjeta',
    createdAt: TIME,
    confirmedAt: TIME,
    updatedAt: TIME,
    totals: { subtotalNet: 1000, discountNet: null, shippingNet: 0, tax: 210, total: 1210 },
    ...(purchaseOrderReference === undefined ? {} : { purchaseOrderReference })
  },
  capabilities: {
    orderStatusUpdate: false,
    shipments: false,
    tracking: false,
    invoices: false,
    customerPreview: false
  },
  customer: { name: null, email: null, phone: null, company: null, companyStatus: null, taxId: null, isGuest: false },
  shippingAddress: null,
  billingAddress: null,
  lines: [],
  payments: [],
  shipments: [],
  returns: [],
  invoices: [],
  notes: [],
  history: [],
  timeline: []
})
let main: ReturnType<typeof ref>, detail: ReturnType<typeof ref>
const wrappers: Array<{ unmount(): void }> = []
beforeEach(() => {
  main = ref(customer())
  detail = ref(admin())
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.session.mockImplementation(() => ({
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }))
  mocks.navigation.mockImplementation(() => ({
    status: ref('ready'),
    capabilities: ref({
      state: 'ready',
      identityId: ACTOR,
      sessionId: SESSION,
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
  }))
  mocks.route.mockReturnValue({ params: { id: ORDER }, query: {}, path: '/pedido/' + ORDER })
  mocks.fetch.mockImplementation((input: string | (() => string)) => {
    const path = typeof input === 'function' ? input() : input
    return {
      data: path.includes('/admin/') ? detail : path.endsWith('/lines') ? ref(null) : main,
      status: ref('success'),
      error: ref(null),
      refresh: vi.fn()
    }
  })
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
async function render(audience: 'customer' | 'admin') {
  if (audience === 'admin')
    mocks.route.mockReturnValue({ params: { id: ORDER }, query: {}, path: '/admin/pedidos/' + ORDER })
  const wrapper = await mountSuspended(audience === 'admin' ? AdminPage : CustomerPage, {
    route: false,
    global: {
      stubs: {
        UiSurface: { template: '<section><slot /></section>' },
        UiPageHeader: { template: '<header><slot name="actions" /></header>' },
        UiEmptyState: true,
        UButton: { template: '<button><slot /></button>' },
        UIcon: true,
        UBadge: true,
        UModal: true,
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        OrderLineThumb: true,
        ReorderDialog: true,
        OrderFiscalSection: true,
        OrderRefundPanel: true,
        AdminRefundActions: true,
        OrderFulfillmentSection: true,
        OrderCancellationPanel: true,
        OrderTimelinePanel: true,
        OrderAnnotationsPanel: true,
        CustomerSatisfactionPanel: true,
        OrderTrackingPanel: true
      }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
it.each(['customer', 'admin'] as const)(
  'shows the existing PO as escaped text in the %s detail, separate from fiscal or private notes',
  async (audience) => {
    const reference = '<img src=x onerror=alert(1)> PO-74'
    main.value = customer(reference)
    detail.value = admin(reference)
    const wrapper = await render(audience),
      field = wrapper.get('[data-testid="order-purchase-reference"]')
    expect(field.text()).toContain('Referencia interna / PO')
    expect(field.text()).toContain(reference)
    expect(field.find('img').exists()).toBe(false)
  }
)
it.each(['customer', 'admin'] as const)(
  'does not invent a PO for an old %s order without the field',
  async (audience) => {
    const wrapper = await render(audience)
    expect(wrapper.find('[data-testid="order-purchase-reference"]').exists()).toBe(false)
  }
)
it.each(['customer', 'admin'] as const)('does not display a null optional PO in the %s detail', async (audience) => {
  main.value = customer(null)
  detail.value = admin(null)
  const wrapper = await render(audience)
  expect(wrapper.find('[data-testid="order-purchase-reference"]').exists()).toBe(false)
})
