import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomerPage from '../../app/pages/pedido/[id].vue'
import AdminPage from '../../app/pages/admin/pedidos/[id].vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
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
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRoute', () => mocks.route)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const ORDER = 'a1000000-0000-4000-8000-000000000070',
  ACTOR = 'a2000000-0000-4000-8000-000000000070',
  SESSION = 'a3000000-0000-4000-8000-000000000070'
const TIME = '2026-10-09T12:00:00Z'
function customer() {
  return {
    source: 'cloudflare',
    id: ORDER,
    status: 'pagado',
    orderStatus: 'paid',
    paymentStatus: 'captured',
    inventoryStatus: 'allocated',
    fulfillmentStatus: 'packed',
    invoiceStatus: 'untracked',
    name: 'Cliente sintético',
    company: null,
    nif: null,
    email: 'synthetic@example.invalid',
    phone: '',
    address: '',
    zip: '',
    city: '',
    province: '',
    notes: null,
    shippingMethod: 'paqueteria',
    paymentMethod: 'tarjeta',
    transferInstructions: null,
    subtotal: 1000,
    shippingCost: 0,
    tax: 210,
    total: 1210,
    createdAt: TIME,
    items: []
  }
}
function admin() {
  return {
    order: {
      id: ORDER,
      status: 'pagado',
      orderStatus: 'confirmed',
      paymentStatus: 'captured',
      fulfillmentStatus: 'packed',
      inventoryStatus: 'allocated',
      invoiceStatus: 'pending',
      shippingMethod: 'parcel',
      paymentMethod: 'tarjeta',
      createdAt: TIME,
      confirmedAt: TIME,
      updatedAt: TIME,
      totals: { subtotalNet: 1000, discountNet: null, shippingNet: 0, tax: 210, total: 1210 }
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
  }
}
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
}
let actor: ReturnType<typeof identity>,
  main: Ref<Record<string, unknown>>,
  detail: Ref<Record<string, unknown>>,
  status: Ref<string>,
  error: Ref<unknown>
let route: { params: { id: string }; query: Record<string, string>; path: string }
const permitted = ref(true)
const wrappers: Array<{ unmount(): void }> = []
beforeEach(() => {
  actor = identity()
  main = ref(customer())
  detail = ref(admin())
  status = ref('success')
  error = ref(null)
  permitted.value = true
  route = reactive({ params: { id: ORDER }, query: {}, path: `/pedido/${ORDER}` })
  mocks.session.mockReturnValue(actor)
  mocks.route.mockImplementation(() => route)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.navigation.mockImplementation(() => ({
    status: ref('ready'),
    capabilities: ref({
      state: 'ready',
      identityId: ACTOR,
      sessionId: SESSION,
      sessionVersion: 1,
      permissions: permitted.value ? ['administration.manage'] : []
    })
  }))
  mocks.fetch.mockImplementation((raw: string | (() => string)) => {
    const path = typeof raw === 'function' ? raw() : raw
    return {
      data: path.includes('/admin/') ? detail : path.endsWith('/lines') ? ref(null) : main,
      status,
      error,
      refresh: vi.fn()
    }
  })
  mocks.request.mockReset().mockImplementation(async (path: string) => ({
    source: 'cloudflare',
    orderId: ORDER,
    audience: path.includes('/admin/') ? 'admin' : main.value?.accessMode === 'view_only' ? 'guest' : 'customer',
    shippingMethod: 'parcel',
    fulfillment: { state: 'packed', version: 2, updatedAt: TIME },
    packing: { parcelCount: 1, recordedAt: TIME },
    shipments: [
      {
        parcelIndex: 0,
        carrier: 'Operador manual sintético',
        trackingNumber: 'TRACK-70',
        recordedAt: TIME,
        verification: 'manual_unverified'
      }
    ],
    carrierEvents: [],
    carrierStatus: 'not_connected',
    fallback: { kind: 'contact_neteco', contactPath: '/contacto' },
    evaluatedAt: TIME
  }))
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
async function render(audience: 'customer' | 'admin' = 'customer') {
  if (audience === 'admin') route.path = `/admin/pedidos/${ORDER}`
  const wrapper = await mountSuspended(audience === 'admin' ? AdminPage : CustomerPage, {
    route: false,
    global: {
      stubs: {
        UiSurface: { template: '<section><slot /></section>' },
        UiPageHeader: { template: '<header><slot name="actions" /></header>' },
        UiEmptyState: { template: '<div><slot /></div>' },
        UButton: { template: '<button><slot /></button>' },
        UIcon: true,
        UBadge: true,
        UModal: true,
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        OrderLineThumb: true,
        ReorderDialog: true,
        OrderFiscalSection: true,
        BeplyOrderPanel: true,
        OrderRefundPanel: true,
        AdminRefundActions: true,
        OrderFulfillmentSection: true,
        OrderCancellationPanel: true,
        OrderTimelinePanel: true,
        OrderAnnotationsPanel: true,
        CustomerSatisfactionPanel: true
      }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('tracking real page mounting', () => {
  it('mounts the existing authenticated customer page with a real tracking read and no writes', async () => {
    const wrapper = await render()
    expect(wrapper.find('[aria-label="Seguimiento operativo del pedido"]').exists()).toBe(true)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/orders/${ORDER}/tracking`,
      expect.objectContaining({ method: 'GET', cache: 'no-store', retry: 0 })
    )
    expect(wrapper.text()).toContain('TRACK-70')
  })
  it('mounts an anonymous view-only guest without requiring a login or sending a token prop/query', async () => {
    actor.loggedIn.value = false
    main.value = { ...customer(), accessMode: 'view_only' }
    const wrapper = await render()
    expect(wrapper.find('[aria-label="Seguimiento operativo del pedido"]').exists()).toBe(true)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/orders/${ORDER}/tracking`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(mocks.request.mock.calls[0]![1]).not.toHaveProperty('query')
    expect(wrapper.text()).toContain('TRACK-70')
  })
  it('mounts admin only on the existing live timeline authority', async () => {
    const wrapper = await render('admin')
    expect(wrapper.find('[aria-label="Seguimiento operativo del pedido"]').exists()).toBe(true)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/admin/orders/${ORDER}/tracking`,
      expect.objectContaining({ method: 'GET' })
    )
  })
  it.each(['node', 'unverified', 'anonymous', 'wrong-order', 'missing-session'])(
    'does not read customer tracking for %s',
    async (boundary) => {
      if (boundary === 'node') main.value = { ...customer(), source: undefined }
      if (boundary === 'unverified') actor.user.value.emailVerified = false
      if (boundary === 'anonymous') actor.loggedIn.value = false
      if (boundary === 'wrong-order') main.value = { ...customer(), id: ACTOR }
      if (boundary === 'missing-session') actor.session.value.sessionId = ''
      const wrapper = await render()
      expect(wrapper.find('[aria-label="Seguimiento operativo del pedido"]').exists()).toBe(false)
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it.each(['node', 'pending', 'error', 'wrong-order', 'permission'])(
    'does not mount admin tracking for %s',
    async (boundary) => {
      if (boundary === 'node')
        mocks.runtime.mockReturnValue({
          app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
          public: { serverRuntime: 'node' }
        })
      if (boundary === 'pending') status.value = 'pending'
      if (boundary === 'error') error.value = { statusCode: 503 }
      if (boundary === 'wrong-order') detail.value = { ...admin(), order: { ...admin().order, id: ACTOR } }
      if (boundary === 'permission') permitted.value = false
      const wrapper = await render('admin')
      expect(wrapper.find('[aria-label="Seguimiento operativo del pedido"]').exists()).toBe(false)
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it('purges customer tracking on identity/session change without rereading another owner from stale main data', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('TRACK-70')
    actor.session.value.sessionVersion++
    await flushPromises()
    expect(wrapper.text()).not.toContain('TRACK-70')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
